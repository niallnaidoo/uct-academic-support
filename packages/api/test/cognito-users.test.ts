/**
 * Unit tests for cognitoUserExists' fail-safe semantics — the single most safety-critical
 * line in the orphan reconciler (a wrong `false` would prune a real admin). Runs in its
 * own test-file process with LOCAL_AUTH UNSET so the real (non-offline) branch executes,
 * driving a mock Cognito client. No DynamoDB/AWS — cognito-users only reads LOCAL_AUTH and
 * takes the client as a parameter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { cognitoUserExists } from '../src/cognito-users.js';

// Sanity: this file must run without the offline gate, or it would short-circuit to true.
test('precondition: LOCAL_AUTH is not set in this process', () => {
  assert.notEqual(process.env.LOCAL_AUTH, '1');
});

const clientThatThrows = (name: string): CognitoIdentityProviderClient =>
  ({
    send: async () => {
      const e = new Error(name);
      (e as { name?: string }).name = name;
      throw e;
    },
  }) as unknown as CognitoIdentityProviderClient;

test('returns false ONLY on UserNotFoundException (a definitive "gone")', async () => {
  assert.equal(
    await cognitoUserExists(clientThatThrows('UserNotFoundException'), 'pool', 'Gone@Example.com'),
    false,
  );
});

test('fails SAFE (true) on any other error — never prunes/blocks on ambiguity', async () => {
  for (const name of ['ThrottlingException', 'InternalErrorException', 'TimeoutError']) {
    assert.equal(await cognitoUserExists(clientThatThrows(name), 'pool', 'a@b.com'), true, name);
  }
});

test('returns true when the user exists', async () => {
  const ok = { send: async () => ({ Username: 'u' }) } as unknown as CognitoIdentityProviderClient;
  assert.equal(await cognitoUserExists(ok, 'pool', 'a@b.com'), true);
});
