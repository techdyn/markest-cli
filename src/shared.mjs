/**
 * @module cli/shared
 * @description The one door from the command to the site's own rules, so a
 *              folder is judged exactly as the editor's folder import judges it,
 *              and an artifact is sealed exactly as the browser seals it, with
 *              nothing copied: which files are documents, what a path may be,
 *              which type a document is, how large it may be, which folders are
 *              never read, how long a server asks to be left alone,
 *              and the envelope, the key and the
 *              link that carries it. The release
 *              snapshot copies these modules beside the command and points this
 *              file at the copies.
 *
 * @input None
 * @output Re-exports of the site's pure modules
 * @dependencies editor/paths, editor/content-type, editor/store, editor/upload-policy,
 *               editor/images, editor/image-transfer, sealed/seal, sealed/key-place
 */

export { validatePath, normalizePath, isAcceptedFile, extensionOf, dirname, basename } from './site/editor/paths.js';
export { detectContentType, isContentType, TYPE_MARKDOWN, TYPE_HTML, TYPE_CODE } from './site/editor/content-type.js';
export { DocumentStore, byteLength, DEFAULT_LIMITS } from './site/editor/store.js';
export { ignoredFolder, reviewFolder } from './site/editor/upload-policy.js';
export { IMAGE_TYPES } from './site/editor/images.js';
export { retryAfterMs } from './site/editor/image-transfer.js';
export { PREFIX as SEAL_PREFIX, isEnvelope, keyText, keyBytes, createKey, keyFromText, sealDocument, openDocument, SealBroken } from './site/sealed/seal.js';
export { FRAGMENT as KEY_FRAGMENT, keyFromHash, keyFromInput, linkWithKey } from './site/sealed/key-place.js';
