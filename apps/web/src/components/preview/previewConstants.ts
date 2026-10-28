export const PREVIEW_RECENT_URL_LIMIT = 10;

export const PREVIEW_ERROR_CODE_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  ERR_NAME_NOT_RESOLVED: "Adresa DNS nu a putut fi găsită",
  ERR_NAME_RESOLUTION_FAILED: "Adresa DNS nu a putut fi găsită",
  ERR_CONNECTION_REFUSED: "Conexiune refuzată",
  ERR_CONNECTION_RESET: "Conexiunea a fost resetată",
  ERR_CONNECTION_CLOSED: "Conexiunea a fost închisă",
  ERR_CONNECTION_TIMED_OUT: "Conexiunea a expirat",
  ERR_INTERNET_DISCONNECTED: "Nu există conexiune la internet",
  ERR_TIMED_OUT: "Conexiunea a expirat",
  ERR_CERT_AUTHORITY_INVALID: "Autoritatea certificatului nu e de încredere",
  ERR_CERT_COMMON_NAME_INVALID: "Numele din certificat nu corespunde",
  ERR_CERT_DATE_INVALID: "Certificatul a expirat sau nu e încă valid",
  ERR_TOO_MANY_REDIRECTS: "Prea multe redirecționări",
});
