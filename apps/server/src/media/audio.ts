import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { config } from '../config/index.js';

const run = promisify(execFile);
const RATE = 48000, CHANNELS = 2, SAMPLE_BYTES = 2;
let active = 0;
export class AudioProcessingError extends Error {
  constructor(public readonly code: 'MEDIA_REJECTED' | 'MEDIA_PROCESSOR_UNAVAILABLE' | 'MEDIA_PROCESSOR_BUSY' | 'MEDIA_PROCESSOR_TIMEOUT', message: string, public readonly status = 415) { super(message); }
}
const rejected = () => new AudioProcessingError('MEDIA_REJECTED', 'Die Audiodatei ist beschädigt, nicht unterstützt oder überschreitet die erlaubten Audiolimits.');

/** Select a bounded, single-file demuxer. Never let an upload select playlists or network protocols. */
export function audioInputFormat(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WAVE') return 'wav';
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') return 'mov';
  if (buf.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (buf.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'aac';
  if (buf[0] === 0xff && (buf[1] & 0xe6) === 0xe2) return 'mp3';
  return null;
}

const probeSchema = z.object({ streams: z.array(z.object({ codec_type: z.string(), channels: z.number().optional(), sample_rate: z.string().optional(), disposition: z.object({ attached_pic: z.number().optional() }).optional() })), format: z.object({ duration: z.string().optional() }).optional() });

/** Full decode, loudness normalization, metadata-free MP3. READY is possible only after every stage succeeds. */
export async function normalizeAudio(filePath: string, format: string): Promise<{ buffer: Buffer; duration: number }> {
  if (active >= config.audioProcessing.concurrency) throw new AudioProcessingError('MEDIA_PROCESSOR_BUSY', 'Die Audioverarbeitung ist ausgelastet. Bitte erneut versuchen.', 503);
  active++;
  const deadline = Date.now() + config.audioProcessing.timeoutMs;
  const execute = async (binary: string, args: string[], maxBuffer: number, input?: Buffer) => {
    const remaining = deadline - Date.now(); if (remaining <= 0) throw new AudioProcessingError('MEDIA_PROCESSOR_TIMEOUT', 'Die Audioverarbeitung hat zu lange gedauert. Bitte erneut versuchen.', 503);
    const child = run(binary, args, { encoding: null, maxBuffer, timeout: remaining, killSignal: 'SIGKILL', windowsHide: true });
    if (input) { child.child.stdin?.on('error', () => {}); child.child.stdin?.end(input); }
    return (await child).stdout;
  };
  try {
    const safeInput = ['-protocol_whitelist', 'file', '-format_whitelist', format, '-f', format];
    const json = await execute(config.audioProcessing.ffprobe, ['-v', 'error', '-max_alloc', '67108864', ...safeInput, '-show_entries', 'format=duration:stream=codec_type,channels,sample_rate:stream_disposition=attached_pic', '-of', 'json', filePath], 65536);
    const probe = probeSchema.parse(JSON.parse(json.toString('utf8'))), audio = probe.streams.filter(s => s.codec_type === 'audio');
    if (audio.length !== 1 || probe.streams.some(s => s.codec_type !== 'audio' && !(s.codec_type === 'video' && s.disposition?.attached_pic === 1))) throw rejected();
    const rate = Number(audio[0].sample_rate), channels = audio[0].channels ?? 0, declaredDuration = Number(probe.format?.duration);
    if (!Number.isFinite(rate) || rate < 8000 || rate > 192000 || channels < 1 || channels > 8 || declaredDuration > config.audioProcessing.maxDurationSeconds + 0.1) throw rejected();
    // Raw PCM makes decoded duration authoritative and prevents metadata/cover art reaching the encoder.
    // Decode at most one second above the limit; an overlong source is rejected, never silently trimmed.
    const pcmLimit = (config.audioProcessing.maxDurationSeconds + 2) * RATE * CHANNELS * SAMPLE_BYTES;
    const pcm = await execute(config.audioProcessing.ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-xerror', '-max_alloc', '67108864', ...safeInput, '-threads', '1', '-err_detect', 'explode', '-i', filePath, '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', String(config.audioProcessing.maxDurationSeconds + 1), '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-filter_threads', '1', '-ar', String(RATE), '-ac', String(CHANNELS), '-f', 's16le', 'pipe:1'], pcmLimit);
    const duration = Math.round(pcm.length / (RATE * CHANNELS * SAMPLE_BYTES) * 1000);
    if (!pcm.length || pcm.length % (CHANNELS * SAMPLE_BYTES) !== 0 || duration > config.audioProcessing.maxDurationSeconds * 1000) throw rejected();
    const buffer = await execute(config.audioProcessing.ffmpeg, ['-hide_banner', '-v', 'error', '-xerror', '-protocol_whitelist', 'pipe', '-f', 's16le', '-ar', String(RATE), '-ac', String(CHANNELS), '-i', 'pipe:0', '-map_metadata', '-1', '-map_chapters', '-1', '-threads', '1', '-c:a', 'libmp3lame', '-b:a', '128k', '-id3v2_version', '0', '-write_id3v1', '0', '-write_xing', '0', '-f', 'mp3', 'pipe:1'], config.maxFileSizes.audio, pcm);
    if (!buffer.length) throw rejected();
    return { buffer, duration };
  } catch (e) {
    if (e instanceof AudioProcessingError) throw e;
    if (e && typeof e === 'object' && 'code' in e && e.code === 'ENOENT') throw new AudioProcessingError('MEDIA_PROCESSOR_UNAVAILABLE', 'Die Audioverarbeitung ist derzeit nicht verfügbar.', 503);
    if (e && typeof e === 'object' && 'killed' in e && e.killed === true && !('code' in e && e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) throw new AudioProcessingError('MEDIA_PROCESSOR_TIMEOUT', 'Die Audioverarbeitung hat zu lange gedauert. Bitte erneut versuchen.', 503);
    throw rejected();
  } finally { active--; }
}
