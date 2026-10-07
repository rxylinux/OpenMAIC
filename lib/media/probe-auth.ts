import { isRejectedRedirectError } from '@/lib/utils/rejected-redirect';

type ConnectivityResult = {
  success: boolean;
  message: string;
};

interface ProbeAuthOptions {
  providerName: string;
  request: () => Promise<Response>;
  /**
   * Non-2xx statuses this probe treats as "reachable with valid credentials".
   * Several providers are probed with a deliberately nonexistent id
   * (`connectivity-test-nonexistent`, unknown task id): a 404 from them proves
   * connectivity and authentication, so it must not read as a failure. Default
   * `[404]`; redirects and 401/403 are never reachable, and every body is
   * cancelled unread.
   */
  reachableStatuses?: number[];
}

/**
 * Shared connectivity-probe envelope for image/video adapters.
 *
 * Results are fixed text: authentication failures, redirects, other HTTP
 * statuses and transport failures each have one message, and no provider body
 * is ever read, so an upstream response cannot reach the caller through the
 * probe result.
 */
export async function probeAuth({
  providerName,
  request,
  reachableStatuses = [404],
}: ProbeAuthOptions): Promise<ConnectivityResult> {
  try {
    const response = await request();
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined);
      return {
        success: false,
        message: `${providerName} connectivity error: Redirects are not allowed`,
      };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return {
        success: false,
        message: `${providerName} auth failed (${response.status})`,
      };
    }
    if (!response.ok && !reachableStatuses.includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      return {
        success: false,
        message: `${providerName} connectivity error: HTTP ${response.status}`,
      };
    }
    await response.body?.cancel().catch(() => undefined);
    return { success: true, message: `Connected to ${providerName}` };
  } catch (err) {
    if (isRejectedRedirectError(err)) {
      return {
        success: false,
        message: `${providerName} connectivity error: Redirects are not allowed`,
      };
    }
    return { success: false, message: `${providerName} connectivity error: request failed` };
  }
}
