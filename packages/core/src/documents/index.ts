// Document outputs (FR-219), image generation (FR-030) and plugin drafts (FR-050), M5. The
// document writers and readers are dependency-free (fflate plus plain XML) and run in-process
// without network access; the tools that use them are re-exported here so one line in the core
// index exposes the whole area.
export {
  DOCUMENT_CONTENT_JSON_SCHEMA,
  DOCUMENT_FORMATS,
  DOCUMENT_MIME,
  docxContentSchema,
  formatOfMime,
  parseDocumentContent,
  pdfContentSchema,
  pptxContentSchema,
  xlsxContentSchema,
  type DocBlock,
  type DocumentContent,
  type DocumentFormat,
  type DocxContent,
  type PdfContent,
  type PptxContent,
  type XlsxContent,
} from './content.ts';
export type {
  ExtractedBlock,
  ExtractedDocument,
  ExtractedPage,
  ExtractedSheet,
  ExtractedSlide,
} from './types.ts';
export { readDocx, writeDocx, type DocumentMeta } from './docx.ts';
export { readPptx, writePptx } from './pptx.ts';
export { readXlsx, writeXlsx } from './xlsx.ts';
export { NO_TEXT_NOTE, readPdf, writePdf } from './pdf.ts';
export {
  MAX_DOCUMENT_BYTES,
  PREVIEW_LIMITS,
  detectFormat,
  documentText,
  extractDocument,
  formatOfName,
  trimForPreview,
  type PreviewLimits,
} from './extract.ts';
export {
  artifactDocumentFormat,
  artifactDocumentPreview,
  buildDocument,
  type BuiltDocument,
} from './build.ts';
export {
  MAX_DOCUMENT_CHARS,
  documentFileName,
  documentTools,
  type DocumentToolOptions,
} from '../tools/documents.ts';
export {
  IMAGE_SIZES,
  canGenerateImages,
  imageTool,
  imageToolSource,
  providerImageGenerator,
  type GeneratedImage,
  type ImageCapableProvider,
  type ImageGenerationRequest,
  type ImageGenerationResult,
  type ImageGenerator,
  type ImageSize,
  type ImageToolOptions,
  type ProviderImageGeneratorOptions,
} from '../tools/images.ts';
export {
  PLUGIN_DRAFTS_DIR,
  pluginFiles,
  pluginScaffoldTool,
  scaffoldPlugin,
  scaffoldRequestSchema,
  type PluginScaffoldToolOptions,
  type ScaffoldRequest,
  type ScaffoldResult,
} from '../plugins/authoring.ts';
