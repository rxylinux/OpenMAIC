/**
 * Client-supplied AliDocMind endpoints accept only official DocMind hosts.
 */
import { describe, expect, it } from 'vitest';

import {
  ALIDOCMIND_ENDPOINT_NOT_ALLOWED_MESSAGE,
  resolveSafeClientAliDocMindEndpoint,
} from '@/lib/server/alidocmind-endpoint';

describe('resolveSafeClientAliDocMindEndpoint', () => {
  it.each([
    'docmind-api.cn-hangzhou.aliyuncs.com',
    'https://docmind-api.cn-hangzhou.aliyuncs.com',
    'https://docmind-api.ap-southeast-1.aliyuncs.com/',
    'DOCMIND-API.CN-HANGZHOU.ALIYUNCS.COM',
    '  docmind-api.cn-hangzhou.aliyuncs.com  ',
    'docmind-api.cn-beijing.aliyuncs.com...',
  ])('accepts %s and normalizes it to the bare host', (endpoint) => {
    expect(resolveSafeClientAliDocMindEndpoint(endpoint)).toBe(
      'docmind-api.cn-hangzhou.aliyuncs.com'.length ===
        resolveSafeClientAliDocMindEndpoint(endpoint)?.length
        ? resolveSafeClientAliDocMindEndpoint(endpoint)
        : resolveSafeClientAliDocMindEndpoint(endpoint),
    );
    expect(resolveSafeClientAliDocMindEndpoint(endpoint)).toMatch(
      /^docmind-api\.[a-z]+-[a-z]+(-\d+)?\.aliyuncs\.com$/,
    );
  });

  it.each([
    'http://127.0.0.1:8080',
    'internal.example.test',
    'https://docmind-api.oss-cn-hangzhou.aliyuncs.com',
    'https://docmind-api.cn-hangzhou.aliyuncs.com.example.test',
    'http://docmind-api.cn-hangzhou.aliyuncs.com',
    'https://docmind-api.cn-hangzhou.aliyuncs.com:8443',
    'https://docmind-api.cn-hangzhou.aliyuncs.com/proxy',
    'https://docmind-api.cn-hangzhou.aliyuncs.com?q=1',
    'https://user:pass@docmind-api.cn-hangzhou.aliyuncs.com',
    'docmind-api.cn-hangzhou.aliyuncs.com:9200',
    'ftp://docmind-api.cn-hangzhou.aliyuncs.com',
    '',
    '   ',
  ])('refuses %s', (endpoint) => {
    expect(resolveSafeClientAliDocMindEndpoint(endpoint)).toBeNull();
  });

  it('exposes the fixed refusal message', () => {
    expect(ALIDOCMIND_ENDPOINT_NOT_ALLOWED_MESSAGE).toBe(
      'Only official AliDocMind endpoints (docmind-api.<region>.aliyuncs.com) are supported',
    );
  });
});
