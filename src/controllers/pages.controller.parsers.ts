/**
 * Request parsing/validation for `pages.controller.ts`: pulling typed,
 * checked values out of `req`/multipart fields before any handler touches
 * pdf-lib, qpdf or pdf_engine.py. Split out of the controller because these
 * are pure functions with no dependency on the controller's `deps` closure.
 */
import type { Request } from 'express';

import { Errors } from '../errors.ts';
import type {
  CropMargins,
  EditColor,
  EditElement,
  EditElementType,
  EditPoint,
  FormFieldValue,
  PageNumberPosition,
  SignColor,
  SignElement,
  SignElementType,
  SignFontStyle,
} from '../services/pdf-pages.service.ts';
import type { CompressLevel } from '../engines/qpdf.engine.ts';
import { getContext } from '../middleware/request-context.ts';

/** `req.file`, or a clear internal error if the upload middleware never set it. */
export function requireSingleFile(req: Request): Express.Multer.File {
  if (!req.file) throw Errors.badRequest('no file part named "file"');
  return req.file;
}

/** The workspace `prepareWorkspace` created, for handlers that need its path directly. */
export function requireWorkspace(req: Request): string {
  const workspace = getContext(req).workspace;
  if (!workspace) throw Errors.internal('workspace missing after prepareWorkspace');
  return workspace;
}

/** A required multipart text field, trimmed - `pages`, `order`. */
export function requireField(req: Request, name: string): string {
  const value = req.body?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw Errors.badPageRange(`The "${name}" field is required.`);
  }
  return value;
}

/** A required, non-blank multipart text field - `text` and `password`. */
export function requireNonEmptyField(req: Request, name: string): string {
  const value = req.body?.[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw Errors.invalidField(`The "${name}" field is required.`);
  }
  return value;
}

/** `degrees` for `/pdf/rotate`: any multiple of 90, clockwise. */
export function parseRotationDegrees(raw: unknown): number {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw.trim())) {
    throw Errors.invalidField('The "degrees" field must be a whole number of degrees.');
  }
  const value = Number.parseInt(raw, 10);
  if (value % 90 !== 0) {
    throw Errors.invalidField('The "degrees" field must be a multiple of 90.');
  }
  return value;
}

/** A non-negative number from a form field, or `fallback` if it was omitted. */
function parseNonNegativeNumber(raw: unknown, fieldName: string, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^\d+(\.\d+)?$/.test(raw.trim())) {
    throw Errors.invalidField(`The "${fieldName}" field must be a non-negative number.`);
  }
  return Number.parseFloat(raw);
}

/** `left`/`right`/`top`/`bottom` for `/pdf/crop`, each in points, defaulting to 0. */
export function parseCropMargins(body: Record<string, unknown> | undefined): CropMargins {
  return {
    left: parseNonNegativeNumber(body?.left, 'left', 0),
    right: parseNonNegativeNumber(body?.right, 'right', 0),
    top: parseNonNegativeNumber(body?.top, 'top', 0),
    bottom: parseNonNegativeNumber(body?.bottom, 'bottom', 0),
  };
}

const PAGE_NUMBER_POSITIONS: readonly PageNumberPosition[] = ['bottom-center', 'bottom-left', 'bottom-right'];

/** `position` for `/pdf/page-numbers`, defaulting to `bottom-center`. */
export function parsePageNumberPosition(raw: unknown): PageNumberPosition {
  if (raw === undefined || raw === null || raw === '') return 'bottom-center';
  if (typeof raw !== 'string' || !PAGE_NUMBER_POSITIONS.includes(raw as PageNumberPosition)) {
    throw Errors.invalidField(`The "position" field must be one of: ${PAGE_NUMBER_POSITIONS.join(', ')}.`);
  }
  return raw as PageNumberPosition;
}

const COMPRESS_LEVELS: readonly CompressLevel[] = ['low', 'medium', 'high'];

/** `level` for `/pdf/compress`, defaulting to `medium` - see `qpdf.engine.ts` for what each one does. */
export function parseCompressLevel(raw: unknown): CompressLevel {
  if (raw === undefined || raw === null || raw === '') return 'medium';
  if (typeof raw !== 'string' || !COMPRESS_LEVELS.includes(raw as CompressLevel)) {
    throw Errors.invalidField(`The "level" field must be one of: ${COMPRESS_LEVELS.join(', ')}.`);
  }
  return raw as CompressLevel;
}

/** `startAt` for `/pdf/page-numbers`: a positive whole number, defaulting to 1. */
export function parseStartAt(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 1;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim()) || Number.parseInt(raw, 10) < 1) {
    throw Errors.invalidField('The "startAt" field must be a positive whole number.');
  }
  return Number.parseInt(raw, 10);
}

/**
 * A `true`/`false` multipart field, defaulting to `fallback` when omitted -
 * `force` on `/pdf/ocr`, `flatten` on `/pdf/fill-form`. Anything else typed
 * in is a mistake worth a clear `E_INVALID_FIELD` rather than being silently
 * coerced, the same reasoning `parseRotationDegrees` applies to `degrees`.
 */
export function parseBooleanField(raw: unknown, fieldName: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw Errors.invalidField(`The "${fieldName}" field must be "true" or "false".`);
}

/**
 * The `fields` multipart field for `/pdf/fill-form`: JSON text naming a
 * value per form field. Parsed and shape-checked here rather than left to
 * `fillForm` in the service, so a malformed request never gets as far as
 * loading the PDF at all - the same "validate the request before touching
 * pdf-lib" order every other handler in this file follows.
 */
export function parseFormFieldsJson(raw: unknown): Record<string, FormFieldValue> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw Errors.invalidField('The "fields" field is required and must be a JSON object.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Errors.invalidField('The "fields" field must be valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw Errors.invalidField('The "fields" field must be a JSON object mapping field names to values.');
  }
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'boolean') {
      throw Errors.invalidField(`The value given for field "${name}" must be a string or a boolean.`);
    }
  }
  return parsed as Record<string, FormFieldValue>;
}

const SIGN_ELEMENT_TYPES: readonly SignElementType[] = ['signature', 'initials', 'stamp', 'name', 'date', 'text'];
const SIGN_FONT_STYLES: readonly SignFontStyle[] = ['cursive', 'cursive2', 'plain'];
const SIGN_COLORS: readonly SignColor[] = ['black', 'red', 'blue', 'green'];

/**
 * The `elements` multipart field for `/pdf/sign`: JSON text describing every
 * mark to bake into the page. Parsed and fully shape-checked here, before
 * `signPdf` ever loads the PDF a second time (via `pdfPageCount` already
 * having loaded it once to know how many pages exist to validate `page`
 * against) - the same "validate the request before touching pdf-lib for the
 * real work" order `parseFormFieldsJson` follows for `/pdf/fill-form`.
 */
export function parseSignElements(raw: unknown, pageCount: number, imageCount: number): SignElement[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw Errors.invalidField('The "elements" field is required and must be a JSON array.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Errors.invalidField('The "elements" field must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw Errors.invalidField('The "elements" field must be a non-empty JSON array.');
  }
  return parsed.map((item, index) => parseSignElement(item, index, pageCount, imageCount));
}

/**
 * One entry of `elements`. Every field the person can control is checked by
 * name (mirroring `parseCropMargins`/`parsePageNumberPosition`'s style of
 * naming the exact field and problem), and the value/imageIndex rule is
 * enforced per the type-specific contract in `pdf-pages.service.ts`'s
 * `SignElement` doc comment: "stamp" REQUIRES `imageIndex` and forbids
 * `value`; "name"/"date"/"text" REQUIRE `value` and forbid `imageIndex`;
 * "signature"/"initials" need EXACTLY one of the two, either is valid.
 */
function parseSignElement(item: unknown, index: number, pageCount: number, imageCount: number): SignElement {
  const label = `elements[${index}]`;
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw Errors.invalidField(`${label} must be a JSON object.`);
  }
  const obj = item as Record<string, unknown>;

  const type = obj.type;
  if (typeof type !== 'string' || !SIGN_ELEMENT_TYPES.includes(type as SignElementType)) {
    throw Errors.invalidField(`${label}.type must be one of: ${SIGN_ELEMENT_TYPES.join(', ')}.`);
  }

  const page = obj.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > pageCount) {
    throw Errors.invalidField(`${label}.page must be a whole page number between 1 and ${pageCount}.`);
  }

  const geometry: Record<string, number> = {};
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    const value = obj[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw Errors.invalidField(`${label}.${field} must be a finite number.`);
    }
    geometry[field] = value;
  }
  if (geometry.width! <= 0 || geometry.height! <= 0) {
    throw Errors.invalidField(`${label}.width and ${label}.height must both be positive.`);
  }

  const hasValue = obj.value !== undefined;
  const hasImageIndex = obj.imageIndex !== undefined;
  const isImageOnlyType = type === 'stamp';
  const isValueOnlyType = type === 'name' || type === 'date' || type === 'text';

  if (isImageOnlyType) {
    if (!hasImageIndex || hasValue) {
      throw Errors.invalidField(`${label}: type "stamp" requires "imageIndex" and must not have "value".`);
    }
  } else if (isValueOnlyType) {
    if (!hasValue || hasImageIndex) {
      throw Errors.invalidField(`${label}: type "${type}" requires "value" and must not have "imageIndex".`);
    }
  } else if (hasValue === hasImageIndex) {
    // signature / initials: exactly one of the two, whichever it is.
    throw Errors.invalidField(`${label}: exactly one of "value" or "imageIndex" is required for type "${type}".`);
  }

  let value: string | undefined;
  if (hasValue) {
    if (typeof obj.value !== 'string' || obj.value.trim() === '') {
      throw Errors.invalidField(`${label}.value must be a non-empty string.`);
    }
    value = obj.value;
  }

  let imageIndex: number | undefined;
  if (hasImageIndex) {
    const rawIndex = obj.imageIndex;
    if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= imageCount) {
      throw Errors.invalidField(
        `${label}.imageIndex must reference one of the ${imageCount} uploaded "images" files.`,
      );
    }
    imageIndex = rawIndex;
  }

  let fontStyle: SignFontStyle | undefined;
  if (obj.fontStyle !== undefined) {
    if (typeof obj.fontStyle !== 'string' || !SIGN_FONT_STYLES.includes(obj.fontStyle as SignFontStyle)) {
      throw Errors.invalidField(`${label}.fontStyle must be one of: ${SIGN_FONT_STYLES.join(', ')}.`);
    }
    fontStyle = obj.fontStyle as SignFontStyle;
  }

  let color: SignColor | undefined;
  if (obj.color !== undefined) {
    if (typeof obj.color !== 'string' || !SIGN_COLORS.includes(obj.color as SignColor)) {
      throw Errors.invalidField(`${label}.color must be one of: ${SIGN_COLORS.join(', ')}.`);
    }
    color = obj.color as SignColor;
  }

  return {
    type: type as SignElementType,
    page,
    x: geometry.x!,
    y: geometry.y!,
    width: geometry.width!,
    height: geometry.height!,
    value,
    imageIndex,
    fontStyle,
    color,
  };
}

const EDIT_ELEMENT_TYPES: readonly EditElementType[] = [
  'text',
  'image',
  'rectangle',
  'ellipse',
  'line',
  'freehand',
];
const EDIT_COLORS: readonly EditColor[] = ['black', 'red', 'blue', 'green', 'yellow', 'orange'];

/**
 * The `elements` multipart field for `/pdf/edit`: JSON text describing every
 * mark to draw. Same shape and same validate-before-`editPdf` order as
 * `parseSignElements` for `/pdf/sign`, its closest precedent - the
 * difference is entirely in what each element TYPE requires, since a
 * general-purpose editor's marks do not share one geometry the way a
 * signature/stamp's fixed box does. See `parseEditElement`.
 */
export function parseEditElements(raw: unknown, pageCount: number, imageCount: number): EditElement[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw Errors.invalidField('The "elements" field is required and must be a JSON array.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Errors.invalidField('The "elements" field must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw Errors.invalidField('The "elements" field must be a non-empty JSON array.');
  }
  return parsed.map((item, index) => parseEditElement(item, index, pageCount, imageCount));
}

/** A required, finite `field` on `obj`, labelled `${label}.${field}` in any error. */
function requireFiniteNumber(obj: Record<string, unknown>, field: string, label: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw Errors.invalidField(`${label}.${field} must be a finite number.`);
  }
  return value;
}

/** The same, but additionally required to be > 0 - `width`/`height` on a box. */
function requirePositiveNumber(obj: Record<string, unknown>, field: string, label: string): number {
  const value = requireFiniteNumber(obj, field, label);
  if (value <= 0) throw Errors.invalidField(`${label}.${field} must be positive.`);
  return value;
}

/**
 * One entry of `/pdf/edit`'s `elements`. Unlike `parseSignElement`, where
 * every type shares one `x`/`y`/`width`/`height` box, each type here is
 * validated against exactly the fields `EditElement`'s doc comment says it
 * needs: a box for `text`/`image`/`rectangle`/`ellipse`, two endpoints for
 * `line`, a point list for `freehand`. Fields a type does not use are simply
 * ignored if present, the same tolerance `parseRedactArea` extends to
 * anything past what it names.
 */
function parseEditElement(item: unknown, index: number, pageCount: number, imageCount: number): EditElement {
  const label = `elements[${index}]`;
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw Errors.invalidField(`${label} must be a JSON object.`);
  }
  const obj = item as Record<string, unknown>;

  const type = obj.type;
  if (typeof type !== 'string' || !EDIT_ELEMENT_TYPES.includes(type as EditElementType)) {
    throw Errors.invalidField(`${label}.type must be one of: ${EDIT_ELEMENT_TYPES.join(', ')}.`);
  }

  const page = obj.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > pageCount) {
    throw Errors.invalidField(`${label}.page must be a whole page number between 1 and ${pageCount}.`);
  }

  let color: EditColor | undefined;
  if (obj.color !== undefined) {
    if (typeof obj.color !== 'string' || !EDIT_COLORS.includes(obj.color as EditColor)) {
      throw Errors.invalidField(`${label}.color must be one of: ${EDIT_COLORS.join(', ')}.`);
    }
    color = obj.color as EditColor;
  }

  let strokeWidth: number | undefined;
  if (obj.strokeWidth !== undefined) {
    strokeWidth = requirePositiveNumber(obj, 'strokeWidth', label);
  }

  let fill: boolean | undefined;
  if (obj.fill !== undefined) {
    if (typeof obj.fill !== 'boolean') throw Errors.invalidField(`${label}.fill must be true or false.`);
    fill = obj.fill;
  }

  const base = { type: type as EditElementType, page, color, strokeWidth, fill };

  if (type === 'text') {
    if (typeof obj.value !== 'string' || obj.value.trim() === '') {
      throw Errors.invalidField(`${label}.value must be a non-empty string.`);
    }
    let fontSize: number | undefined;
    if (obj.fontSize !== undefined) fontSize = requirePositiveNumber(obj, 'fontSize', label);
    return {
      ...base,
      value: obj.value,
      fontSize,
      x: requireFiniteNumber(obj, 'x', label),
      y: requireFiniteNumber(obj, 'y', label),
    };
  }

  if (type === 'image') {
    const rawIndex = obj.imageIndex;
    if (typeof rawIndex !== 'number' || !Number.isInteger(rawIndex) || rawIndex < 0 || rawIndex >= imageCount) {
      throw Errors.invalidField(
        `${label}.imageIndex must reference one of the ${imageCount} uploaded "images" files.`,
      );
    }
    return {
      ...base,
      imageIndex: rawIndex,
      x: requireFiniteNumber(obj, 'x', label),
      y: requireFiniteNumber(obj, 'y', label),
      width: requirePositiveNumber(obj, 'width', label),
      height: requirePositiveNumber(obj, 'height', label),
    };
  }

  if (type === 'rectangle' || type === 'ellipse') {
    return {
      ...base,
      x: requireFiniteNumber(obj, 'x', label),
      y: requireFiniteNumber(obj, 'y', label),
      width: requirePositiveNumber(obj, 'width', label),
      height: requirePositiveNumber(obj, 'height', label),
    };
  }

  if (type === 'line') {
    return {
      ...base,
      x1: requireFiniteNumber(obj, 'x1', label),
      y1: requireFiniteNumber(obj, 'y1', label),
      x2: requireFiniteNumber(obj, 'x2', label),
      y2: requireFiniteNumber(obj, 'y2', label),
    };
  }

  // freehand
  if (!Array.isArray(obj.points) || obj.points.length < 2) {
    throw Errors.invalidField(`${label}.points must be an array of at least 2 {x, y} points.`);
  }
  const points: EditPoint[] = obj.points.map((point, pointIndex) => {
    if (typeof point !== 'object' || point === null || Array.isArray(point)) {
      throw Errors.invalidField(`${label}.points[${pointIndex}] must be a JSON object.`);
    }
    const pointObj = point as Record<string, unknown>;
    return {
      x: requireFiniteNumber(pointObj, 'x', `${label}.points[${pointIndex}]`),
      y: requireFiniteNumber(pointObj, 'y', `${label}.points[${pointIndex}]`),
    };
  });
  return { ...base, points };
}

/** One entry of `/pdf/redact`'s `areas` field - see `parseRedactAreas`. */
interface RedactArea {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The `areas` multipart field for `/pdf/redact`: a JSON array naming every
 * rectangle to strip. Parsed and fully shape-checked here, before
 * `pdf_engine.py` is ever invoked - the same "validate the request before
 * touching the real engine" order `parseSignElements` follows for
 * `/pdf/sign` (its closest precedent: also a JSON-array-of-placement-objects
 * field). `page` is checked against `pageCount` here, client-side of the
 * Python call, the same defense-in-depth every other page-selecting
 * endpoint in this file already applies via `pdfPageCount` - `pdf_engine.py`
 * itself also rejects an out-of-range `page`, but that check existing too
 * does not make this one redundant: this one is what keeps a malformed
 * request from ever reaching a subprocess at all.
 *
 * An empty array is rejected rather than treated as a no-op: unlike
 * `/pdf/sign`'s `elements` (where a caller might reasonably build up marks
 * across several requests), "redact nothing" is not a coherent redaction
 * request - there is no reason to invoke this endpoint at all with nothing
 * to remove, and treating it as a silent success would only hide a caller
 * bug that forgot to populate `areas`.
 */
export function parseRedactAreas(raw: unknown, pageCount: number): RedactArea[] {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw Errors.invalidField('The "areas" field is required and must be a JSON array.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw Errors.invalidField('The "areas" field must be valid JSON.');
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw Errors.invalidField('The "areas" field must be a non-empty JSON array.');
  }
  return parsed.map((item, index) => parseRedactArea(item, index, pageCount));
}

/** One entry of `areas` - see `parseRedactAreas`. */
function parseRedactArea(item: unknown, index: number, pageCount: number): RedactArea {
  const label = `areas[${index}]`;
  if (typeof item !== 'object' || item === null || Array.isArray(item)) {
    throw Errors.invalidField(`${label} must be a JSON object.`);
  }
  const obj = item as Record<string, unknown>;

  const page = obj.page;
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > pageCount) {
    throw Errors.invalidField(`${label}.page must be a whole page number between 1 and ${pageCount}.`);
  }

  const geometry: Record<string, number> = {};
  for (const field of ['x', 'y', 'width', 'height'] as const) {
    const value = obj[field];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw Errors.invalidField(`${label}.${field} must be a finite number.`);
    }
    geometry[field] = value;
  }
  if (geometry.width! <= 0 || geometry.height! <= 0) {
    throw Errors.invalidField(`${label}.width and ${label}.height must both be positive.`);
  }

  return {
    page,
    x: geometry.x!,
    y: geometry.y!,
    width: geometry.width!,
    height: geometry.height!,
  };
}

/** `every` for `/pdf/split`: a positive whole number of pages, defaulting to 1. */
export function parsePositivePageCount(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 1;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim()) || Number.parseInt(raw, 10) < 1) {
    throw Errors.badPageRange('The "every" field must be a positive whole number of pages.');
  }
  return Number.parseInt(raw, 10);
}
