import fs from 'node:fs/promises';
import sharp from 'sharp';
import { config } from '../config/index.js';
import { audioInputFormat, normalizeAudio, AudioProcessingError } from './audio.js';

export interface ProcessedMedia {
  ok: boolean;
  error?: { code: string; message: string };
  buffer?: Buffer;
  type?: 'image' | 'audio';
  mimeType?: string;
  width?: number;
  height?: number;
  duration?: number;
}

/**
 * Prüft den tatsächlichen Content. Bilder: decodieren via sharp, EXIF/Metadaten-
 * Strip, als WebP normalisieren. Audio: vollständig decodieren und normalisieren.
 * Das Format/MIME kommt aus dem Content, nie aus der Client-Assertion.
 */
export async function processUploaded(filePath: string, fileSize: number): Promise<ProcessedMedia> {
  const rejected = (message: string): ProcessedMedia => ({ ok: false, error: { code: 'MEDIA_REJECTED', message } });
  try {
    const buf = await fs.readFile(filePath);
    if (fileSize > config.maxFileSizes.upload) return rejected('Datei ist zu groß.');

    // Erst: Bild? sharp meldet bei nicht-Bildern einen Fehler.
    let imageMeta: { width?: number; height?: number; format?: string } | null = null;
    try {
      const input = sharp(filePath, { failOn: 'error' });
      const metadata = await input.metadata();
      if (metadata.format && metadata.width && metadata.height) imageMeta = metadata;
    } catch {
      imageMeta = null; // kein Bild → evtl. Audio
    }

    if (imageMeta) {
      if (fileSize > config.maxFileSizes.image) return rejected('Bilddatei ist zu groß.');
      const { width, height, format } = imageMeta;
      if (width! > config.maxFileSizes.imageDimension || height! > config.maxFileSizes.imageDimension) {
        return rejected(`Bild ist zu groß (max. ${config.maxFileSizes.imageDimension}px).`);
      }
      if (format !== 'jpeg' && format !== 'png' && format !== 'webp') {
        return rejected('Nur JPG, PNG oder WebP sind erlaubt.');
      }
      const normalized = await sharp(filePath, { animated: false })
        .rotate() // EXIF-Orientation anwenden
        .webp({ quality: 85 })
        .toBuffer({ resolveWithObject: true });
      return { ok: true, buffer: normalized.data, type: 'image', mimeType: 'image/webp', width, height };
    }

    // Kein Bild → Audio?
    const audioFormat = audioInputFormat(buf);
    if (audioFormat) {
      if (fileSize > config.maxFileSizes.audio) return rejected('Audiodatei ist zu groß.');
      const normalized = await normalizeAudio(filePath, audioFormat);
      return { ok: true, ...normalized, type: 'audio', mimeType: 'audio/mpeg' };
    }

    return rejected('Nicht unterstützter oder beschädigter Inhalt (nur JPG/PNG/WebP oder MP3/WAV/M4A/AAC/OGG).');
  } catch (error) {
    if (error instanceof AudioProcessingError) throw error;
    return rejected('Datei konnte nicht gelesen oder verarbeitet werden.');
  }
}

