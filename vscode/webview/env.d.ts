// esbuild loads .css files as text (see esbuild.mjs)
declare module '*.css' {
  const text: string
  export default text
}
