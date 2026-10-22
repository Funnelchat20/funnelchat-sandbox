/**
 * The `file` of a send, as conversations v1.18.10 reads it (`SendFileType`, `MessageTypeEnum::messageTypeByFileExtension`,
 * `SupportedFileExtensionEnum` and `lang/es/public_api.php`), on `POST contacts/{contact}/message` and
 * `POST message/send-message`:
 *
 * - `file` is an absolute `http(s)` URL (signed, or without an extension) or a plain file name, up to 4096 characters;
 * - `file_type` (`image`, `video`, `audio`, `document`, `sticker`) and `file_name` are optional and ignored without
 *   `file`; an explicit `file_type` always wins;
 * - without `file_type`, the type comes from the extension: the one of the URL's path if it is supported, else the
 *   one of the whole URL if supported (a signed URL that ends in `.pdf`), else the path's even if unsupported;
 * - a URL that does not reveal its format needs `file_type` (`422 errors.file_type`); a document from a URL whose
 *   extension is not supported needs a `file_name` with one (`422 errors.file_name`);
 * - a known but unsupported extension (`.zip`) without `file_type` is `415`, with each route's own body.
 */
import { RawApiError, validationFailed } from '../http/errors.js';
import type { FieldErrors } from '../openapi/validate.js';

export const SEND_FILE_TYPES = ['image', 'video', 'audio', 'document', 'sticker'] as const;
export type SendFileType = (typeof SEND_FILE_TYPES)[number];

/** `SupportedFileExtensionEnum`, mapped to the type of `messageTypeByFileExtension`. */
export const SUPPORTED_EXTENSIONS: Record<string, SendFileType> = {
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  webp: 'sticker',
  ogg: 'audio',
  oga: 'audio',
  mp3: 'audio',
  m4a: 'audio',
  aac: 'audio',
  opus: 'audio',
  wav: 'audio',
  gif: 'video',
  mp4: 'video',
  doc: 'document',
  docx: 'document',
  pdf: 'document',
};

/**
 * Extensions with a registered MIME type (symfony/mime): a URL that ends in one says its format, even when WhatsApp
 * does not take it. The real list is symfony's, much longer: these are the common ones.
 */
const KNOWN_EXTENSIONS = new Set([
  ...Object.keys(SUPPORTED_EXTENSIONS),
  ...['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'txt', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'md', 'rtf', 'odt', 'ods', 'odp'],
  ...['xls', 'xlsx', 'ppt', 'pptx', 'epub', 'apk', 'exe', 'js', 'css', 'ics', 'vcf'],
  ...['bmp', 'tif', 'tiff', 'svg', 'heic', 'heif', 'avif', 'ico', 'psd'],
  ...['mov', 'avi', 'mkv', 'webm', '3gp', 'mpeg', 'mpg', 'wmv', 'flv', 'm4v'],
  ...['flac', 'amr', 'wma', 'mid', 'midi', 'aiff', 'weba'],
]);

const FILE_MAX_LENGTH = 4096;
const FILE_NAME_MAX = 255;
// The `\x00` is SendFileType's: a plain name cannot carry a NUL.
// eslint-disable-next-line no-control-regex
const FILE_PATTERN = /^(?:[Hh][Tt][Tt][Pp][Ss]?:\/\/.+|(?!\.\.?$)(?![Hh][Tt][Tt][Pp])[^/\\\x00]+)$/u;
const FILE_NAME_FORBIDDEN = /[\p{Cc}\p{Cf}/\\?#]/u;

const FILE_TYPE_MESSAGE =
  'Tu archivo viene de una URL que no indica su formato: envía file_type con uno de estos valores: image, video, audio, document o sticker.';
const FILE_NAME_MESSAGE =
  'Para enviar un documento desde una URL que no termina en una de las extensiones admitidas, envía file_name con su extensión, por ejemplo factura.pdf.';

const isUrl = (file: string): boolean => /^http/i.test(file);

function extensionOfText(text: string): string {
  const last = text.split('/').pop() ?? '';
  const dot = last.lastIndexOf('.');
  return dot > 0 || (dot === 0 && last.length > 1) ? last.slice(dot + 1).toLowerCase() : '';
}

/** `SendFileType::extensionOf`: the path's extension if supported, else the whole URL's if supported, else the path's. */
export function extensionOf(file: string): string {
  let path = file;
  if (isUrl(file)) {
    try {
      path = decodeURIComponent(new URL(file).pathname);
    } catch {
      path = file.split(/[?#]/)[0] ?? file;
    }
  }
  const fromPath = extensionOfText(path);
  if (fromPath in SUPPORTED_EXTENSIONS) return fromPath;
  const fromWhole = extensionOfText(file.split('#')[0] ?? file);
  if (fromWhole in SUPPORTED_EXTENSIONS) return fromWhole;
  return fromPath;
}

/** The two bodies of the `415`: `contacts/{contact}/message` lists the supported types, `send-message` does not. */
export type UnsupportedStyle = 'conversation' | 'direct';

export interface ResolvedFile {
  file: string;
  type: SendFileType;
  fileName: string | null;
}

/**
 * Validates `file`, `file_type` and `file_name` of a send and resolves the message type. Returns `null` without a
 * file. Throws the `422` of the field, or the `415` of the route.
 */
export function resolveFile(body: Record<string, unknown>, style: UnsupportedStyle): ResolvedFile | null {
  const raw = body.file;
  if (raw === undefined || raw === null || raw === '') return null;
  const errors: FieldErrors = {};
  const file = String(raw);
  if (file.length > FILE_MAX_LENGTH) errors.file = [`El campo file no debe tener más de ${FILE_MAX_LENGTH} caracteres.`];
  else if (!FILE_PATTERN.test(file)) errors.file = ['El formato del campo file no es válido.'];

  const fileType = body.file_type === undefined || body.file_type === null ? null : body.file_type;
  if (fileType !== null && !(SEND_FILE_TYPES as readonly unknown[]).includes(fileType)) errors.file_type = ['El file_type seleccionado no es válido.'];

  const fileName = body.file_name === undefined || body.file_name === null ? null : body.file_name;
  if (fileName !== null) {
    if (typeof fileName !== 'string') errors.file_name = ['El campo file_name debe ser una cadena de caracteres.'];
    else if (fileName.length < 1) errors.file_name = ['El campo file_name debe tener al menos 1 caracteres.'];
    else if (fileName.length > FILE_NAME_MAX) errors.file_name = [`El campo file_name no debe tener más de ${FILE_NAME_MAX} caracteres.`];
    else if (FILE_NAME_FORBIDDEN.test(fileName)) errors.file_name = ['El formato del campo file_name no es válido.'];
  }
  if (Object.keys(errors).length) throw validationFailed(errors);

  const extension = extensionOf(file);
  if (isUrl(file)) {
    // The `after` hook of SendFileType: only for URLs.
    if (fileType === null && !KNOWN_EXTENSIONS.has(extension)) throw validationFailed({ file_type: [FILE_TYPE_MESSAGE] });
    if (fileType === 'document' && !(extension in SUPPORTED_EXTENSIONS)) {
      const named = typeof fileName === 'string' ? extensionOfText(fileName) : '';
      if (!KNOWN_EXTENSIONS.has(named)) throw validationFailed({ file_name: [FILE_NAME_MESSAGE] });
    }
  }

  if (fileType !== null) return { file, type: fileType as SendFileType, fileName: fileName as string | null };
  const type = SUPPORTED_EXTENSIONS[extension];
  if (type) return { file, type, fileName: fileName as string | null };
  const error = `Unsupported file type: ${extension}`;
  throw new RawApiError(
    415,
    style === 'conversation' ? { error, supported_file_types: Object.keys(SUPPORTED_EXTENSIONS) } : { status: 'error', error },
  );
}
