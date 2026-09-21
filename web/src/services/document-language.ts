/**
 * Languages the UI ships translations for.
 *
 * Both views keep their own copy of this union; the service only needs the
 * values, so it accepts the same shape without forcing a shared type on them.
 */
export type DocumentLanguage = "zh" | "en" | "de" | "ru" | "ja";

/** The BCP 47 tag each UI language maps to for `<html lang>`. */
const DOCUMENT_LANGUAGE_TAGS: Record<DocumentLanguage, string> = {
  zh: "zh-CN",
  en: "en",
  de: "de",
  ru: "ru",
  ja: "ja",
};

/**
 * Keep `<html lang>` in sync with the selected UI language.
 *
 * index.html hardcodes `lang="zh-CN"` and nothing ever rewrote it — only the
 * theme was applied to the document element. Switching to English, German,
 * Russian or Japanese therefore left screen readers, translation prompts and
 * hyphenation treating the page as Chinese.
 */
export function applyDocumentLanguage(language: DocumentLanguage): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = DOCUMENT_LANGUAGE_TAGS[language] ?? "en";
}
