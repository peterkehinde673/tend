# Security Policy

## Reporting a vulnerability

Please do not disclose security vulnerabilities in a public issue.

Instead, contact the repository owner privately through the security contact available on the GitHub repository profile. Include:

- A concise description of the issue.
- The affected file, endpoint, or component.
- Reproduction steps or a proof of concept when safe to provide.
- The potential impact.

Please allow reasonable time for investigation before public disclosure.

## Security expectations

Never commit:

- Ring access tokens or webhook HMAC secrets.
- AWS credentials or session tokens.
- `.env` files containing real values.
- Production household identifiers or event data.

Tend's repository checks are designed to verify security invariants in code and infrastructure. They do not constitute proof that a deployed external AWS or Ring account is secure or correctly configured.
