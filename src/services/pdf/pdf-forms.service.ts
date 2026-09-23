/**
 * AcroForm field operations: listing what a PDF's form contains, and filling
 * it in. Split out of pdf-pages.service.ts as its own domain - forms are a
 * different object model (`PDFField` subclasses) from the page-geometry
 * operations there.
 */
import {
  PDFCheckBox,
  PDFDropdown,
  PDFOptionList,
  PDFRadioGroup,
  PDFTextField,
  type PDFField,
} from 'pdf-lib';

import { Errors } from '../../errors.ts';
import { loadPdf } from './pdf.shared.ts';

export type FormFieldType = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'optionList' | 'button' | 'unknown';

export interface FormFieldSummary {
  name: string;
  type: FormFieldType;
  value: string | boolean | string[] | undefined;
  /** Choices for `radio`/`dropdown`/`optionList` fields only. */
  options?: string[];
}

/**
 * Read `field`'s type, current value and (for the choice-based types) its
 * options - switching on its constructor rather than a discriminant field,
 * because that is the only way pdf-lib exposes which subclass a `PDFField`
 * actually is.
 *
 * `unknown` covers `PDFSignature` and any future field type pdf-lib adds:
 * this endpoint's contract is "list what you can read", and a field this
 * code does not recognise is more honest reported as unknown-with-no-value
 * than crammed into the nearest existing bucket.
 */
function summarizeField(field: PDFField): FormFieldSummary {
  const name = field.getName();

  if (field instanceof PDFTextField) {
    return { name, type: 'text', value: field.getText() };
  }
  if (field instanceof PDFCheckBox) {
    return { name, type: 'checkbox', value: field.isChecked() };
  }
  if (field instanceof PDFRadioGroup) {
    return { name, type: 'radio', value: field.getSelected(), options: field.getOptions() };
  }
  if (field instanceof PDFDropdown) {
    return { name, type: 'dropdown', value: field.getSelected(), options: field.getOptions() };
  }
  if (field instanceof PDFOptionList) {
    return { name, type: 'optionList', value: field.getSelected(), options: field.getOptions() };
  }
  // PDFButton (a push button - no user-entered value) and anything else
  // pdf-lib might expose (PDFSignature today) share the same "no value to
  // read" answer, so they are not worth telling apart by name here.
  return { name, type: field.constructor.name === 'PDFButton' ? 'button' : 'unknown', value: undefined };
}

/**
 * Every AcroForm field in the PDF, or `[]` if it has no AcroForm at all.
 *
 * A missing form is not an error - the same "opened fine, nothing to
 * extract" answer `Errors.noTables`/`Errors.noLayers` give a document that
 * genuinely has none, except here an empty array is already an unambiguous
 * "no fields" without needing a dedicated error code: JSON has a value for
 * "nothing", where a binary PDF/zip response does not.
 *
 * `getForm()` throws if the AcroForm dictionary itself is present but
 * corrupt (as opposed to simply absent, which pdf-lib treats as "create one
 * on demand" and never reaches for a read-only listing) - wrapped into
 * `Errors.convertFailed` rather than a raw 500, matching how `loadPdf`
 * treats a PDF that fails to parse at all.
 */
export async function listFormFields(bytes: Buffer): Promise<FormFieldSummary[]> {
  const document = await loadPdf(bytes);
  let form;
  try {
    form = document.getForm();
  } catch (error) {
    throw Errors.convertFailed(error);
  }
  return form.getFields().map(summarizeField);
}

export type FormFieldValue = string | boolean;

/**
 * Fill named AcroForm fields with `values` and return the resulting PDF,
 * flattening it into permanent page content first if `flatten` is true.
 *
 * Each field name is resolved with `getFieldMaybe` rather than `getField`
 * so an unknown name can be turned into a clear `Errors.invalidField` naming
 * it, instead of the generic pdf-lib exception `getField` throws.
 *
 * Setting a field is wrapped per-field in its own try/catch: pdf-lib throws
 * a plain `Error` for a value that does not fit the field (a string handed
 * to `PDFCheckBox`, an option `select()` does not recognise), and that
 * exception's message already names the field and the problem - exactly what
 * `Errors.invalidField` needs, so it is reused directly rather than replaced
 * with a generic one.
 *
 * `flatten()` is called last, after every field is set: flattening BEFORE
 * filling would already have baked in whatever value the field started
 * with (its default, or nothing) and removed the field pdf-lib needs to set
 * a new one on - there is no "flatten a field that still exists" step to
 * reorder around, filling has to happen while the fields are still fields.
 */
export async function fillForm(
  bytes: Buffer,
  values: Readonly<Record<string, FormFieldValue>>,
  options: { flatten?: boolean } = {},
): Promise<Buffer> {
  const document = await loadPdf(bytes);
  let form;
  try {
    form = document.getForm();
  } catch (error) {
    throw Errors.convertFailed(error);
  }

  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) {
      throw Errors.invalidField(`There is no form field named "${name}" in this PDF.`);
    }
    try {
      setFieldValue(field, value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw Errors.invalidField(`The value given for field "${name}" is not valid: ${message}`);
    }
  }

  if (options.flatten) {
    form.flatten();
  }

  return Buffer.from(await document.save());
}

/** Set one field's value, dispatching on its concrete pdf-lib subclass. */
function setFieldValue(field: PDFField, value: FormFieldValue): void {
  if (field instanceof PDFTextField) {
    field.setText(String(value));
    return;
  }
  if (field instanceof PDFCheckBox) {
    if (typeof value !== 'boolean') {
      throw new Error('a checkbox needs a boolean value (true or false)');
    }
    if (value) field.check();
    else field.uncheck();
    return;
  }
  if (field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) {
    field.select(String(value));
    return;
  }
  throw new Error(`fields of type "${field.constructor.name}" cannot be filled`);
}
