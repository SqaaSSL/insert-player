const HTTP_URL_PATTERN = /https?:\/\/[^\s"'`<>\)\],;]+/gi;

export function httpUrlsInText(text) {
  const urls = [];
  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    try {
      const url = new URL(match[0]);
      if (url.protocol === 'http:' || url.protocol === 'https:') urls.push(url);
    } catch {
      // Invalid URL-shaped text is not a trusted origin reference.
    }
  }
  return urls;
}

export function textReferencesOrigin(text, expectedOrigin) {
  const expected = new URL(expectedOrigin);
  return httpUrlsInText(text).some((candidate) => candidate.origin === expected.origin);
}

export function textReferencesHostname(text, expectedHostnames) {
  const expected = new Set(expectedHostnames.map((hostname) => hostname.toLowerCase()));
  return httpUrlsInText(text).some((candidate) => expected.has(candidate.hostname.toLowerCase()));
}
