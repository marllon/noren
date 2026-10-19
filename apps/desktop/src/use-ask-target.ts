import type { Backend, Config, OllamaModels } from "@noren/model";
import { useEffect, useState } from "react";
import { askNeedsOllama, askTarget } from "./ask-panel";
import type { AskFunction, AskTarget } from "./ask-panel";

/** Who answers `fn`, and whether the answer to that is still being looked for. */
export interface AskTargetState {
  target: AskTarget | undefined;
  /** The settings name nobody and the Ollama of this computer has not been asked for its models yet. */
  looking: boolean;
}

/**
 * The provider and model that answer `fn` (see `askTarget`). When the settings do not say, the Ollama
 * of this computer is asked for its models, once (and again if the settings change in a way that
 * makes it needed).
 */
export function useAskTarget(
  backend: Pick<Backend, "ai">,
  config: Pick<Config, "ai">,
  fn: AskFunction,
): AskTargetState {
  const [ollama, setOllama] = useState<OllamaModels | undefined>();
  const wantsOllama = askNeedsOllama(config, fn);
  const target = askTarget(config, ollama, fn);

  useEffect(() => {
    if (!wantsOllama) return undefined;
    let current = true;
    backend.ai.listOllamaModels().then(
      (found) => {
        if (current) setOllama(found);
      },
      () => {
        if (current) setOllama({ found: false });
      },
    );
    return () => {
      current = false;
    };
  }, [backend, wantsOllama]);

  return { target, looking: target === undefined && wantsOllama && ollama === undefined };
}
