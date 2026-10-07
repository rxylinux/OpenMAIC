/**
 * The pinned transports for image/video provider requests.
 *
 * The address policy follows endpoint provenance, never request input:
 *
 *  - a caller-supplied base URL (honored when the provider is not
 *    server-managed) is arbitrary request input and runs under the strict
 *    public policy — private/loopback/CGNAT targets are refused even when the
 *    operator opted into ALLOW_LOCAL_NETWORKS, and a 3xx is refused;
 *  - a server-managed provider's base URL is operator configuration and may
 *    point at a local network without the opt-in;
 *  - an unmanaged provider's catalog default is a code constant, so the
 *    operator address policy applies (a self-hosted deployment with the
 *    local-network opt-in keeps working when the caller names an unmanaged
 *    provider without sending a base URL).
 *
 * Cloud metadata and reserved ranges stay refused under all three. Either way
 * the connect address is pinned to the vetted DNS answers and a 3xx is
 * refused rather than followed.
 *
 * The adapters live in modules the settings UI also imports, so they cannot
 * import this server transport themselves; every server caller injects it
 * through the config's `fetchImpl`.
 */
import { providerFetch, type ProviderFetchPolicy } from '@/lib/server/provider-fetch';
import type { MediaProviderFetch } from '@/lib/media/types';

const MEDIA_PROVIDER_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: undefined,
  rejectRedirects: true,
};

const MANAGED_MEDIA_PROVIDER_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: true,
  rejectRedirects: true,
};

const CALLER_MEDIA_PROVIDER_POLICY: ProviderFetchPolicy = {
  allowLocalNetworks: false,
  rejectRedirects: true,
};

/**
 * Who supplied the endpoint, as the route resolved it server-side (never from
 * request input): managed = operator configuration; callerSupplied = an
 * explicit request base URL; anything else = a fixed catalog default.
 */
export interface MediaEndpointProvenance {
  managed?: boolean;
  callerSupplied?: boolean;
}

/** The pinned transport policy for an endpoint with this provenance. */
export function mediaEndpointPolicy(provenance: MediaEndpointProvenance = {}): ProviderFetchPolicy {
  if (provenance.managed) return MANAGED_MEDIA_PROVIDER_POLICY;
  if (provenance.callerSupplied) return CALLER_MEDIA_PROVIDER_POLICY;
  return MEDIA_PROVIDER_POLICY;
}

/** Transport for a caller-supplied base URL: strict public policy. */
export const callerMediaProviderFetch: MediaProviderFetch = (input, init) =>
  providerFetch(input, init, CALLER_MEDIA_PROVIDER_POLICY);

/** Transport for a fixed catalog default: operator address policy. */
export const mediaProviderFetch: MediaProviderFetch = (input, init) =>
  providerFetch(input, init, MEDIA_PROVIDER_POLICY);

/** Transport for a server-managed provider, whose base URL is operator configuration. */
export const managedMediaProviderFetch: MediaProviderFetch = (input, init) =>
  providerFetch(input, init, MANAGED_MEDIA_PROVIDER_POLICY);

/**
 * `config` with the pinned media transport for its endpoint provenance
 * installed. Both flags are the route's server-side resolution of operator
 * configuration — never request input.
 */
export function withMediaProviderFetch<T extends object>(
  config: T,
  provenance: MediaEndpointProvenance = {},
): T & { fetchImpl: MediaProviderFetch } {
  const policy = mediaEndpointPolicy(provenance);
  return {
    ...config,
    fetchImpl: (input: string, init?: RequestInit) => providerFetch(input, init, policy),
  };
}
