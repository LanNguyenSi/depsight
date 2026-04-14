# Changelog

## Unreleased

### Security

- Bump `next` to 15.5.15 to address **GHSA-q4gf-8mx6-v5v3** (high-severity Denial of Service via Server Components, affects `>=13.0.0 <15.5.15`). The App Router pages in this dashboard render via RSC, so the vulnerable code path was reachable. Same-minor patch, no functional changes expected.
