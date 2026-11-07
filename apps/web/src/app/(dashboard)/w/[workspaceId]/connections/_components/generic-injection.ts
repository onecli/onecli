import {
  type InjectionConfig,
  injectionConfigSchema,
  isHeaderInjection,
  isParamInjection,
  isPathRegexInjection,
  isPathTemplateInjection,
} from "@onecli/api/validations/secret";

/** How a custom connection's key travels on the wire. */
type SentAs = "bearer" | "header" | "param" | "path";
type PathMode = "template" | "regex";

export const SENT_AS_OPTIONS: ReadonlyArray<{ value: SentAs; label: string }> =
  [
    { value: "bearer", label: "Bearer token" },
    { value: "header", label: "Custom header" },
    { value: "param", label: "URL parameter" },
    { value: "path", label: "URL path" },
  ];

export const PATH_MODE_OPTIONS: ReadonlyArray<{
  value: PathMode;
  label: string;
}> = [
  { value: "template", label: "Template" },
  { value: "regex", label: "Regex" },
];

export const DEFAULT_HEADER_NAME = "X-Api-Key";
export const DEFAULT_PARAM_NAME = "api_key";
const VALUE_TOKEN = "{value}";
const BEARER_FORMAT = "Bearer {value}";
const PREVIEW_MASK = "••••••";
const PREVIEW_FILLER = "<token>";

/** Form state behind the custom connection's "Sent as" section. */
export interface GenericInjection {
  sentAs: SentAs;
  headerName: string;
  paramName: string;
  /** Wraps the key for a custom header or URL parameter (e.g.
   * `Token {value}`). Applied only while `formatOpen`: closed, the key is
   * sent as-is. */
  format: string;
  formatOpen: boolean;
  pathMode: PathMode;
  pathTemplate: string;
  pathRegex: string;
  pathReplacement: string;
}

export const DEFAULT_GENERIC_INJECTION: GenericInjection = {
  sentAs: "bearer",
  headerName: "",
  paramName: "",
  format: "",
  formatOpen: false,
  pathMode: "template",
  pathTemplate: "",
  pathRegex: "",
  pathReplacement: "",
};

/** A stored format opens the format field only when it wraps the key. */
const withFormat = (format: string): Partial<GenericInjection> =>
  format === VALUE_TOKEN ? {} : { format, formatOpen: true };

const fromHeader = (
  headerName: string,
  valueFormat: string,
): GenericInjection =>
  // Exact name match only: a lowercase `authorization` must round-trip as-is.
  headerName === "Authorization" && valueFormat === BEARER_FORMAT
    ? DEFAULT_GENERIC_INJECTION
    : {
        ...DEFAULT_GENERIC_INJECTION,
        sentAs: "header",
        headerName,
        ...withFormat(valueFormat),
      };

const fromParam = (
  paramName: string,
  paramFormat: string,
): GenericInjection => ({
  ...DEFAULT_GENERIC_INJECTION,
  sentAs: "param",
  paramName,
  ...withFormat(paramFormat),
});

/** Map a stored injection config onto the form (edit mode). */
export const injectionFromConfig = (
  config: InjectionConfig | null,
): GenericInjection => {
  if (isParamInjection(config))
    return fromParam(config.paramName, config.paramFormat ?? VALUE_TOKEN);
  if (isHeaderInjection(config))
    // Every writer stores a format; a missing one is read as Bearer, the
    // way the form has always loaded it.
    return fromHeader(config.headerName, config.valueFormat ?? BEARER_FORMAT);
  if (isPathTemplateInjection(config))
    return {
      ...DEFAULT_GENERIC_INJECTION,
      sentAs: "path",
      pathTemplate: config.pathTemplate,
    };
  if (isPathRegexInjection(config))
    return {
      ...DEFAULT_GENERIC_INJECTION,
      sentAs: "path",
      pathMode: "regex",
      pathRegex: config.pathRegex,
      pathReplacement: config.pathReplacement,
    };
  return DEFAULT_GENERIC_INJECTION;
};

/**
 * Map a create-time prefill onto the form. The prefill comes from the
 * gateway's "add your API key" link, so its defaults are the ones that link
 * documents: header `Authorization`, format `Bearer {value}`, and a URL
 * parameter sent as-is.
 */
export const injectionFromPrefill = (prefill: {
  headerName?: string;
  valueFormat?: string;
  paramName?: string;
  paramFormat?: string;
}): GenericInjection =>
  prefill.paramName
    ? fromParam(prefill.paramName, prefill.paramFormat || VALUE_TOKEN)
    : fromHeader(
        prefill.headerName ?? "Authorization",
        prefill.valueFormat ?? BEARER_FORMAT,
      );

/** The format a custom header or URL parameter saves. */
const savedFormat = (s: GenericInjection) =>
  (s.formatOpen && s.format.trim()) || VALUE_TOKEN;

/** The injection config a custom connection saves. */
export const buildGenericInjectionConfig = (
  s: GenericInjection,
): InjectionConfig => {
  switch (s.sentAs) {
    case "bearer":
      return { headerName: "Authorization", valueFormat: BEARER_FORMAT };
    case "header":
      return {
        headerName: s.headerName.trim() || DEFAULT_HEADER_NAME,
        valueFormat: savedFormat(s),
      };
    case "param":
      return {
        paramName: s.paramName.trim() || DEFAULT_PARAM_NAME,
        paramFormat: savedFormat(s),
      };
    case "path":
      return s.pathMode === "template"
        ? { pathTemplate: s.pathTemplate }
        : { pathRegex: s.pathRegex, pathReplacement: s.pathReplacement };
  }
};

/** Why the value format can't be saved: a format without `{value}` would
 * send the format text instead of the key. */
export const formatError = (s: GenericInjection): string | null =>
  (s.sentAs === "header" || s.sentAs === "param") &&
  !savedFormat(s).includes(VALUE_TOKEN)
    ? "Include {value} where the key goes."
    : null;

/** Whether the form describes a config the API accepts (the API's own
 * schema decides, so the two can't drift). */
export const isGenericInjectionValid = (s: GenericInjection) =>
  formatError(s) === null &&
  injectionConfigSchema.safeParse(buildGenericInjectionConfig(s)).success;

const mask = (format: string) => format.replaceAll(VALUE_TOKEN, PREVIEW_MASK);

/** The one-line masked preview of a header or URL parameter, derived from
 * the config that will be saved (null for URL path). */
export const sentAsPreview = (s: GenericInjection): string | null => {
  const config = buildGenericInjectionConfig(s);
  if (isHeaderInjection(config))
    return `${config.headerName}: ${mask(config.valueFormat ?? VALUE_TOKEN)}`;
  if (isParamInjection(config))
    return `?${config.paramName}=${mask(config.paramFormat ?? VALUE_TOKEN)}`;
  return null;
};

/**
 * A masked before/after preview of a URL-path rewrite the API would accept
 * (null otherwise). Mirrors the gateway's substitution without revealing the
 * key: template mode shows the request path with the `{value}` slot filled,
 * regex mode the pattern and the masked replacement.
 */
export const pathPreview = (
  s: GenericInjection,
): { before: string; after: string } | null => {
  if (s.sentAs !== "path" || !isGenericInjectionValid(s)) return null;
  if (s.pathMode === "regex")
    return { before: s.pathRegex, after: mask(s.pathReplacement) };
  const [prefix, suffix = ""] = s.pathTemplate.split(VALUE_TOKEN);
  const tail = suffix || "/…";
  return {
    before: `${prefix}${PREVIEW_FILLER}${tail}`,
    after: `${prefix}${PREVIEW_MASK}${tail}`,
  };
};

/** Whether a stored path pattern limits anything: `*` and `/*` match every
 * path, the same as no pattern at all. */
export const isPathLimit = (pattern: string | null | undefined) =>
  !!pattern && !["*", "/*"].includes(pattern.trim());
