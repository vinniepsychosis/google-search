// puppeteer-extra-plugin-stealth ships no usable type declarations (its
// package.json "types" field is a command string, not a path). Declare a
// minimal ambient module so TypeScript accepts the default import. The plugin
// is only ever passed to `chromium.use(...)`, so `any` is sufficient here.
declare module "puppeteer-extra-plugin-stealth" {
  const StealthPlugin: (...args: any[]) => any;
  export default StealthPlugin;
}
