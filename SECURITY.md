# Security Policy

## Supported Versions

Security fixes target the `main` branch.

## Reporting a Vulnerability

Please report security issues privately by email:

```text
yangyihao.app@gmail.com
```

Do not open a public issue for secrets, authentication bypasses, token leakage, or stored sensitive data.

## Sensitive Data

This project can use local credentials for Feishu and WeChat public platform sessions. Treat these as secrets:

- `FEISHU_APP_SECRET`
- `W2F_WECHAT_MP_TOKEN`
- `W2F_WECHAT_MP_COOKIE`
- local `.env` files
- exported article archives if they contain private content

The repository ignores `.env` and local history files by default. Before publishing logs or screenshots, check that tokens and cookies are redacted.
