import React, { lazy } from 'react';

export type PreloadableLazy = React.LazyExoticComponent<React.ComponentType<any>> & {
  preload: () => Promise<unknown>;
};

/**
 * React.lazy with an explicit, retryable preload hook.
 *
 * Keep the module promise outside React's private lazy payload. A speculative
 * preload that fails can then be retried when the user actually opens the App,
 * instead of leaving React.lazy permanently rejected or pending.
 */
export const createPreloadableLazy = (
  factory: () => Promise<{ default: React.ComponentType<any> }>,
): PreloadableLazy => {
  let request: Promise<{ default: React.ComponentType<any> }> | null = null;

  const load = () => {
    if (!request) {
      const nextRequest = factory();
      request = nextRequest;
      void nextRequest.catch(() => {
        if (request === nextRequest) request = null;
      });
    }
    return request;
  };

  const Component = lazy(load) as PreloadableLazy;
  Component.preload = load;
  return Component;
};
