# Contributing

Thanks for taking the time to improve W2F Vault.

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Before Opening a Pull Request

Run the verification commands:

```bash
npm test
npm run build
```

Keep changes focused. If a change touches WeChat extraction, Feishu import, or account batch export behavior, add or update tests in `tests/`.

## Environment

Copy `.env.example` to `.env` for local development. Do not commit `.env`, cookies, tokens, exported articles, or local history files.

## Pull Request Guidelines

- Describe the user-facing behavior change.
- Mention any new environment variables or setup steps.
- Include screenshots for UI changes when helpful.
- Link related issues when applicable.

## Maintainer Notes

This project intentionally uses app credentials and local session cookies instead of OAuth. Avoid adding telemetry or remote services unless the change is explicit and documented.
