/**
 * Barrel re-export: PDF page/form/sign/edit operations now live in
 * `./pdf/*.service.ts`, split by domain (page geometry, AcroForm fields,
 * the signature stamp, general-purpose markup). This path is kept so every
 * existing importer keeps working unchanged.
 */
export * from './pdf/pdf-pages.service.ts';
export * from './pdf/pdf-forms.service.ts';
export * from './pdf/pdf-sign.service.ts';
export * from './pdf/pdf-edit.service.ts';
