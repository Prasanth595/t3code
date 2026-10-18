# t3code factory docs site

The VitePress site at [factory.originalsolutions.com.au](https://factory.originalsolutions.com.au). `npm run dev` serves it locally and `npm run build` builds it, both from this folder after `npm ci`.

## Screenshots

The images in `public/screenshots/` are taken from the fork's own web app, running on fictional demo data: the `acme/storefront` and `acme/billing` runs in [`scripts/demo-data.ts`](scripts/demo-data.ts). Retake them all when the factory UI changes:

```sh
vp i                                          # at the repo root, once
npm --prefix factory/site ci
npx --prefix factory/site playwright install chromium-headless-shell
npm --prefix factory/site run screenshots
```

The script seeds a throwaway T3 home in a new temp directory, starts `vp run dev` on it, captures each page in light and dark with headless Chromium, then stops the server it started and deletes the temp directory. It never touches `~/.t3`, `~/.t3code-factory` or `~/.config/t3fac`. The server gets an empty `GH_CONFIG_DIR` and no GitHub token, and no T3 project is seeded, so the factory has no repo to watch and nothing to ask GitHub.

Look at every image before committing it: none should show an error, a warning or a connection banner.
