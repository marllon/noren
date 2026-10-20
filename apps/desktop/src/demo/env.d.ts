/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in the web demo build (`vite build --mode demo`), empty in every other build. */
  readonly VITE_NOREN_DEMO: string;
}
