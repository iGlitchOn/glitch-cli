import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Part } from '@google/genai';

export const BRACKETED_PASTE_START = '\x1b[200~';
export const BRACKETED_PASTE_END = '\x1b[201~';
export const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
export const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

export type BracketedPasteSegment =
  | { kind: 'paste'; text: string }
  | { kind: 'input'; text: string };

/**
 * Normaliza el texto pegado eliminando marcadores de bracketed paste (\x1b[200~ y \x1b[201~)
 * y convirtiendo \r\n o \r en \n para conservar intactos todos los saltos de línea.
 */
export function normalizePastedText(raw: string): string {
  if (!raw) return '';
  const cleaned = raw
    .split(BRACKETED_PASTE_START)
    .join('')
    .split(BRACKETED_PASTE_END)
    .join('');
  return cleaned.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Detector stateful de Bracketed Paste Mode (\x1b[200~ ... \x1b[201~).
 * Agrupa todo el contenido entre las secuencias de inicio y fin como un único bloque 'paste',
 * incluso si llega fragmentado en varios chunks de stdin.
 */
export class BracketedPasteParser {
  private inPaste = false;
  private pasteBuffer = '';
  private pendingPrefix = '';

  isPasting(): boolean {
    return this.inPaste;
  }

  reset(): void {
    this.inPaste = false;
    this.pasteBuffer = '';
    this.pendingPrefix = '';
  }

  push(chunk: string): BracketedPasteSegment[] {
    const segments: BracketedPasteSegment[] = [];
    let data = this.pendingPrefix + chunk;
    this.pendingPrefix = '';

    while (data.length > 0) {
      if (!this.inPaste) {
        const startIdx = data.indexOf(BRACKETED_PASTE_START);
        if (startIdx === -1) {
          // Revisar si el final de data coincide con un prefijo parcial de \x1b[200~
          const partialLen = this.findTrailingPartialMatch(
            data,
            BRACKETED_PASTE_START,
          );
          if (partialLen > 0) {
            const before = data.slice(0, data.length - partialLen);
            if (before.length > 0) {
              segments.push({ kind: 'input', text: before });
            }
            this.pendingPrefix = data.slice(data.length - partialLen);
            break;
          }
          segments.push({ kind: 'input', text: data });
          break;
        }

        if (startIdx > 0) {
          segments.push({ kind: 'input', text: data.slice(0, startIdx) });
        }
        this.inPaste = true;
        this.pasteBuffer = '';
        data = data.slice(startIdx + BRACKETED_PASTE_START.length);
      } else {
        const endIdx = data.indexOf(BRACKETED_PASTE_END);
        if (endIdx === -1) {
          const partialLen = this.findTrailingPartialMatch(
            data,
            BRACKETED_PASTE_END,
          );
          if (partialLen > 0) {
            this.pasteBuffer += data.slice(0, data.length - partialLen);
            this.pendingPrefix = data.slice(data.length - partialLen);
          } else {
            this.pasteBuffer += data;
          }
          break;
        }

        this.pasteBuffer += data.slice(0, endIdx);
        segments.push({
          kind: 'paste',
          text: normalizePastedText(this.pasteBuffer),
        });
        this.pasteBuffer = '';
        this.inPaste = false;
        data = data.slice(endIdx + BRACKETED_PASTE_END.length);
      }
    }

    return segments;
  }

  private findTrailingPartialMatch(text: string, marker: string): number {
    const maxCheck = Math.min(text.length, marker.length - 1);
    for (let len = maxCheck; len >= 1; len--) {
      if (text.endsWith(marker.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }
}

export interface ClipboardPasteResult {
  kind: 'image' | 'text' | 'empty';
  value: string;
  displayTag?: string;
}

const pastedImageMap = new Map<string, string>();

export function registerPastedImagePath(filePath: string): string {
  const normalized = path.normalize(filePath.trim().replace(/^["']|["']$/g, ''));
  const baseName = path.basename(normalized);
  let tagName = baseName;
  let suffix = 2;

  while (
    pastedImageMap.has(tagName.toLowerCase()) &&
    pastedImageMap.get(tagName.toLowerCase()) !== normalized
  ) {
    const ext = path.extname(baseName);
    const stem = path.basename(baseName, ext);
    tagName = `${stem}-${suffix}${ext}`;
    suffix++;
  }

  pastedImageMap.set(tagName.toLowerCase(), normalized);
  return `[${tagName}]`;
}

export function getRegisteredImagePath(tagName: string): string | undefined {
  const clean = tagName.replace(/^\[|\]$/g, '').trim().toLowerCase();
  return pastedImageMap.get(clean);
}

export function unregisterPastedImageTag(tagName: string): boolean {
  const clean = tagName.replace(/^\[|\]$/g, '').trim().toLowerCase();
  return pastedImageMap.delete(clean);
}

export function snapshotPastedImageMap(): Map<string, string> {
  return new Map(pastedImageMap);
}

export function restorePastedImageMap(
  snapshot: ReadonlyMap<string, string>,
): void {
  pastedImageMap.clear();
  for (const [k, v] of snapshot.entries()) {
    pastedImageMap.set(k, v);
  }
}

export function getClipboardTempDir(customHomeDir?: string): string {
  const home = customHomeDir ?? os.homedir();
  const dir = path.join(home, '.glitch', 'tmp', 'images');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function isImageFilePath(candidate: string): boolean {
  const clean = candidate.trim().replace(/^["']|["']$/g, '');
  if (clean.includes('\n') || clean.includes('\r')) {
    return false;
  }
  return /\.(png|jpg|jpeg|webp|gif|bmp)$/i.test(clean);
}

/**
 * Si el usuario pega una ruta de imagen con click derecho en la terminal o arrastra un archivo,
 * la convierte automáticamente en `[NOMBRE DE LA IMAGEN]` en la TUI y registra su ruta real internamente,
 * conservando los saltos de línea (\n) si se trata de texto multilínea.
 */
export function transformPastedChunkWithImages(rawInput: string): string {
  if (!rawInput) return rawInput;

  const normalized = normalizePastedText(rawInput);
  const trimmed = normalized.trim().replace(/^["']|["']$/g, '');
  if (
    normalized.length > 3 &&
    !trimmed.includes('\n') &&
    isImageFilePath(trimmed) &&
    (/^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('/'))
  ) {
    return `${registerPastedImagePath(trimmed)} `;
  }

  return normalized.replace(
    /(?:"([a-zA-Z]:[\\/][^"\r\n]+\.(?:png|jpg|jpeg|webp|gif|bmp))"|'([a-zA-Z]:[\\/][^'\r\n]+\.(?:png|jpg|jpeg|webp|gif|bmp))'|([a-zA-Z]:[\\/][^\s"'\]]+\.(?:png|jpg|jpeg|webp|gif|bmp)))/gi,
    (fullMatch, quotedDouble, quotedSingle, unquoted) => {
      const candidate = (quotedDouble || quotedSingle || unquoted || '').trim();
      if (candidate && isImageFilePath(candidate)) {
        return registerPastedImagePath(candidate);
      }
      return fullMatch;
    },
  );
}

/**
 * Lee el portapapeles de Windows al presionar Ctrl+V o click derecho:
 * - Si hay una imagen en el portapapeles (captura de pantalla) o un archivo de imagen copiado,
 *   la guarda en ~/.glitch/tmp/images/clipboard-<ts>.png, registra `[NOMBRE DE LA IMAGEN]` y devuelve su etiqueta y ruta.
 * - Si hay texto, devuelve el texto conservando todos sus saltos de línea (\n) tal cual.
 */
export function readWindowsClipboard(
  customHomeDir?: string,
): ClipboardPasteResult {
  if (process.platform !== 'win32') {
    return { kind: 'empty', value: '' };
  }

  const outDir = getClipboardTempDir(customHomeDir);
  const targetPng = path.join(outDir, `clipboard-${Date.now()}.png`);
  const escapedPng = targetPng.replace(/'/g, "''");

  const psScript = [
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    'Add-Type -AssemblyName System.Windows.Forms;',
    'Add-Type -AssemblyName System.Drawing;',
    'if ([System.Windows.Forms.Clipboard]::ContainsImage()) {',
    '  $img = [System.Windows.Forms.Clipboard]::GetImage();',
    `  $img.Save('${escapedPng}', [System.Drawing.Imaging.ImageFormat]::Png);`,
    `  [Console]::Out.Write('IMAGE:${escapedPng}');`,
    '  exit 0;',
    '}',
    'if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {',
    '  $files = [System.Windows.Forms.Clipboard]::GetFileDropList();',
    '  if ($files.Count -gt 0) {',
    '    [Console]::Out.Write("FILE:" + $files[0]);',
    '    exit 0;',
    '  }',
    '}',
    'if ([System.Windows.Forms.Clipboard]::ContainsText()) {',
    '  $txt = [System.Windows.Forms.Clipboard]::GetText();',
    '  [Console]::Out.Write("TEXT:" + $txt);',
    '  exit 0;',
    '}',
  ].join(' ');

  try {
    const raw = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', psScript],
      { encoding: 'utf-8', timeout: 4000, windowsHide: true },
    );

    if (raw.startsWith('IMAGE:')) {
      const imgPath = raw.slice('IMAGE:'.length).trim();
      const displayTag = registerPastedImagePath(imgPath);
      return { kind: 'image', value: imgPath, displayTag };
    }
    if (raw.startsWith('FILE:')) {
      const filePath = raw.slice('FILE:'.length).trim();
      if (isImageFilePath(filePath)) {
        const displayTag = registerPastedImagePath(filePath);
        return { kind: 'image', value: filePath, displayTag };
      }
      return { kind: 'text', value: filePath };
    }
    if (raw.startsWith('TEXT:')) {
      const text = normalizePastedText(raw.slice('TEXT:'.length));
      const trimmedSingle = text.trim();
      if (!trimmedSingle.includes('\n') && isImageFilePath(trimmedSingle)) {
        const cleanPath = trimmedSingle.replace(/^["']|["']$/g, '');
        const displayTag = registerPastedImagePath(cleanPath);
        return { kind: 'image', value: cleanPath, displayTag };
      }
      return { kind: 'text', value: transformPastedChunkWithImages(text) };
    }
  } catch {
    // Fallback silencioso
  }

  return { kind: 'empty', value: '' };
}

function getMimeTypeForImage(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'image/png';
}

/**
 * Detecta etiquetas `[NOMBRE DE LA IMAGEN]` (ej. `[captura.png]`), `[Imagen: <ruta>]`
 * o rutas directas `C:\...\foto.png` dentro del mensaje del usuario:
 * - En la UI el usuario solo ve `[NOMBRE DE LA IMAGEN]`.
 * - Internamente inyecta la ruta exacta en el texto enviado al modelo y adjunta el `inlineData`
 *   (base64) de la imagen para que la IA pueda analizarla tanto visualmente como por ruta.
 */
export function buildUserPartsWithImages(userText: string): Part[] {
  const parts: Part[] = [];
  const attachedPaths = new Map<string, string>(); // path -> tag

  let internalPromptText = userText;

  // 1. Etiquetas [NOMBRE_IMAGEN.ext] registradas con Ctrl+V o click derecho
  const tagRegex = /\[([^\[\]\r\n]+\.(?:png|jpg|jpeg|webp|gif|bmp))\]/gi;
  let match: RegExpExecArray | null;
  while ((match = tagRegex.exec(userText)) !== null) {
    const tagInner = match[1]?.trim() ?? '';
    const registered = getRegisteredImagePath(tagInner);
    const mappedPath =
      registered ||
      (fs.existsSync(tagInner) ? path.resolve(tagInner) : undefined);
    if (mappedPath) {
      attachedPaths.set(mappedPath, `[${tagInner}]`);
    }
  }

  // 2. Etiquetas clásicas [Imagen: <ruta>]
  const legacyBracketRegex = /\[Imagen:\s*([^\]]+)\]/gi;
  while ((match = legacyBracketRegex.exec(userText)) !== null) {
    const candidate = match[1]?.trim().replace(/^["']|["']$/g, '');
    if (candidate && isImageFilePath(candidate)) {
      attachedPaths.set(candidate, `[${path.basename(candidate)}]`);
    }
  }

  // 3. Rutas directas de Windows C:\...\archivo.png
  const winPathRegex =
    /([a-zA-Z]:[\\/][^\s"'\]]+\.(?:png|jpg|jpeg|webp|gif|bmp))/gi;
  while ((match = winPathRegex.exec(userText)) !== null) {
    const candidate = match[1]?.trim();
    if (candidate) {
      attachedPaths.set(candidate, `[${path.basename(candidate)}]`);
    }
  }

  const internalNotes: string[] = [];
  for (const [imgPath, displayTag] of attachedPaths.entries()) {
    internalNotes.push(`${displayTag} -> Ruta interna: ${imgPath}`);
    try {
      if (fs.existsSync(imgPath)) {
        const bytes = fs.readFileSync(imgPath);
        parts.push({
          inlineData: {
            mimeType: getMimeTypeForImage(imgPath),
            data: bytes.toString('base64'),
          },
        });
      }
    } catch {
      // Continúa con la ruta en texto si no se pudo leer el binario
    }
  }

  if (internalNotes.length > 0) {
    internalPromptText = `${userText}\n\n[ Imágenes adjuntas para análisis de la IA: ${internalNotes.join(' | ')} ]`;
  }

  parts.push({ text: internalPromptText });
  return parts;
}

let lastCopiedClipboardText = '';

export function getLastCopiedClipboardText(): string {
  return lastCopiedClipboardText;
}

export function writeTextToClipboard(text: string): boolean {
  lastCopiedClipboardText = text;
  if (process.env['VITEST']) {
    return true;
  }
  try {
    if (process.platform === 'win32') {
      execFileSync('clip', [], {
        input: text,
        encoding: 'utf-8',
        timeout: 2500,
        windowsHide: true,
      });
      return true;
    }
  } catch {
    // Fallback silencioso
  }
  return true;
}

export function isSafeHttpUrl(candidateUrl: string): boolean {
  const clean = candidateUrl.trim();
  if (!/^https?:\/\/[^\s"'<>`]+$/i.test(clean)) {
    return false;
  }
  try {
    const parsed = new URL(clean);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function openExternalHttpUrl(candidateUrl: string): boolean {
  if (!isSafeHttpUrl(candidateUrl)) {
    return false;
  }
  const safeUrl = candidateUrl.trim();
  if (process.env['VITEST']) {
    return true;
  }
  try {
    if (process.platform === 'win32') {
      const escapedForCmd = safeUrl.replace(/[&|<>^]/g, (ch) => `^${ch}`);
      const child = spawn('cmd.exe', ['/c', 'start', '""', escapedForCmd], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return true;
    }
  } catch {
    return false;
  }
  return true;
}
