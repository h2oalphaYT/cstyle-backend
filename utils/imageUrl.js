import config from '../config/env.js';

// Images are stored in MongoDB as server-relative paths ("/uploads/products/x.webp") so the
// public host can change without rewriting data. API responses always carry absolute URLs.

export const toPublicUrl = (storedPath) => {
    if (!storedPath) return '';
    if (/^https?:\/\//i.test(storedPath)) return storedPath;
    const p = storedPath.startsWith('/') ? storedPath : `/${storedPath}`;
    return `${config.apiBaseUrl}${p}`;
};

// Accepts an absolute URL produced by toPublicUrl (or a relative path) and returns the stored form.
// External http(s) URLs on other hosts are kept as-is.
export const toStoredPath = (url) => {
    if (!url || typeof url !== 'string') return '';
    const trimmed = url.trim();
    if (trimmed.startsWith(config.apiBaseUrl)) return trimmed.slice(config.apiBaseUrl.length);
    const match = trimmed.match(/^https?:\/\/[^/]+(\/uploads\/.+)$/i);
    if (match) return match[1];
    return trimmed;
};
