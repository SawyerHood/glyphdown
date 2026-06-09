/**
 * The KaTeX stylesheet is imported dynamically inside math.ts so it rides
 * the lazy katex chunk (vite extracts and injects it, fonts included). This
 * ambient declaration keeps tsc happy about the CSS specifier.
 */
declare module 'katex/dist/katex.min.css' {
  const css: undefined
  export default css
}
