// Global CSS Module declarations for Vite/CSS modules
declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
  export = classes;
}
