# Privacy Policy for LoRA Manager Bridge

**Last updated: 2026-07-31**

## What this extension does

LoRA Manager Bridge is a browser extension that queries your **locally running** ComfyUI server to check whether models you browse on CivitAI are already in your personal library. It displays this information as visual badges on CivitAI web pages.

## Data collection

**This extension does not collect, transmit, or store any personal data.**

Specifically:

- **Your browsing data**: The extension reads the URL of the CivitAI page you're viewing solely to extract the model ID. This information is only used to query your local ComfyUI server. It is never sent to any external server.
- **Your model library data**: The extension queries `http://127.0.0.1` (your own computer) to check which models you have. The responses are cached temporarily in the browser's service worker memory only — they are not persisted to disk or transmitted anywhere.
- **Settings**: Your ComfyUI server address and cache preferences are stored locally in your browser via `chrome.storage.sync`. This data stays on your device (and optionally syncs across your own devices via your browser account).
- **No analytics, no tracking, no telemetry**: The extension contains no analytics code, no ad networks, and no third-party services.

## Third-party services

The extension does not integrate with any third-party services. It only communicates with:
- Your local ComfyUI server at the address you configure (default: `http://127.0.0.1:8188`)
- Your browser's own extension storage APIs

## Permissions

The extension requests the following permissions, each for a specific purpose:

| Permission | Why |
|-----------|-----|
| `storage` | To save your ComfyUI address and cache settings |
| `http://127.0.0.1:*/*` | To communicate with your local ComfyUI server |
| `http://localhost:*/*` | Same as above |
| Content script on civitai.com / civitai.red | To add visual badges to model pages you visit |

## Contact

If you have questions about this privacy policy, please open an issue at:
https://github.com/shiruixa/lora-manager-bridge

## Changes to this policy

Any changes to this privacy policy will be reflected in the extension's GitHub repository and included in future updates.
