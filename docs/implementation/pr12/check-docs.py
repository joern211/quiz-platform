#!/usr/bin/env python3
"""Check traceability and document structure, not runtime acceptance."""
from pathlib import Path
import re
from collections import Counter

ROOT = Path(__file__).resolve().parents[3]
SPEC = ROOT / 'docs/specs/pr12'
errors = []
def require(condition, message):
    if not condition: errors.append(message)
def cells(line):
    return [c.strip() for c in re.split(r'(?<!\\)\|', line)[1:-1]]

groups_text = (SPEC / 'requirements-groups.md').read_text()
groups = set(re.findall(r'^\| (MR-[0-9A-Z-]+)(?=\s)', groups_text, re.M))
matrix = (SPEC / 'requirements-matrix.md').read_text()
ids = []
parents = Counter()
sections = set()
for line in matrix.splitlines():
    if not re.match(r'^\| MR-[0-9A-Z-]+-A\d+ §', line): continue
    c = cells(line)
    require(len(c) == 11, f'Column count: {c[0]}')
    if len(c) != 11: continue
    ident = c[0].split()[0]
    ids.append(ident)
    parent = re.sub(r'-A\d+$', '', ident)
    parents[parent] += 1
    sections.add(int(ident.split('-')[1]))
    require(parent in groups, f'Unknown parent: {ident}')
    require(f'AT-{ident}:' in c[9], f'Missing planned acceptance: {ident}')
    require(c[2] in {'P','O','L','X'}, f'Scope status: {ident}: {c[2]}')
    require(c[3] in {'F', 'N', 'V', 'O'}, f'Decision status: {ident}: {c[3]}')
    require(c[4] in {'M', 'NV'}, f'Unproven implementation claim: {ident}')
    require(all(c), f'Empty attribute: {ident}')
    require(f'`{ident}`' in matrix.split('## Vollständige Alt-ID')[1], f'Unmapped child: {ident}')
require(len(ids) == len(set(ids)), 'Duplicate atomic ID')
require(set(parents) == groups - {'MR-16-00-01'}, 'Missing or extra parent group')
require(sections == set(range(1,21)), 'Missing Master section')
require({f'16.{n}' for n in range(1,18)} <= set(re.findall(r'§(\d+\.\d+)', matrix)), 'Missing Yacht subsection source')
require(f'{len(ids)} atomare MR-Zeilen' in matrix, 'Stale matrix count')

require('Mitspielender Host (FEST, Master §2/§10)' in (SPEC / 'technical-mapping.md').read_text(), 'Missing shared host fairness contract')

specs = [p for p in (SPEC / 'games').glob('*.md') if p.name != 'index.md']
require(len(specs) == 19, 'Game specification count')
for p in specs:
    text = p.read_text()
    require('## 13.' in text and 'technical-mapping.md §3.4' in text, f'Engine contract: {p.name}')
    require('kein Mic/Send' in text and 'hört `MAIN`' in text and 'nie `TEAM`' in text and 'deaktivieren' in text, f'Viewer policy: {p.name}')
    require(not re.search(r'Mikrofon MUTED\s*\(Default\)', text), f'Unsupported microphone default: {p.name}')
    require('Voice-PFlicht' not in text, f'Conflicting voice obligation: {p.name}')
# Check relative Markdown file targets. Fragment validity is a separate manual
# check; source-code hints such as srv:foo are not file links.
for p in list(SPEC.rglob('*.md')) + list((ROOT / 'docs/implementation/pr12').glob('*.md')):
    text = p.read_text()
    for target in re.findall(r'\]\(([^)]+)\)', text):
        target = target.split('#')[0]
        if not target or re.match(r'[a-z]+:', target): continue
        require((p.parent / target).is_file(), f'Broken file link: {p.relative_to(ROOT)} -> {target}')
    require('/Users/' not in text, f'Private machine path: {p.name}')
registry = (SPEC / 'decision-register.md').read_text()
# DEC-001/002 and DEC-STD-01 are explicitly resolved aliases in routine rows.
known = set(re.findall(r'\bDEC-(?:[A-Z0-9]+-)?\d+\b', registry))
for p in SPEC.rglob('*.md'):
    references = set(re.findall(r'\bDEC-(?:[A-Z0-9]+-)?\d+\b', p.read_text()))
    require(references <= known, f'Unknown decision IDs in {p.name}: {sorted(references-known)}')
if errors:
    print('\n'.join(errors))
    raise SystemExit(1)
print(f'OK: {len(ids)} atomic IDs, {len(parents)} source groups + split index, 20 Master sections, 19 game contracts/viewer policies, relative file links')
print('These checks do not prove runtime behavior, semantic completeness, or user approval of proposals.')
