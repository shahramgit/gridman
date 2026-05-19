const { describe, it, expect } = require('@jest/globals');

import { getRequestFromCurlCommand } from './index';

describe('getRequestFromCurlCommand', () => {
  it('should parse data-urlencode values into form url encoded body params', () => {
    const request = getRequestFromCurlCommand(`
      curl --location 'http://localhost:8090/oauth2/token' \
      --header 'Content-Type: application/x-www-form-urlencoded' \
      --header 'Authorization: Basic YW5kcm9pZC51c2VyOjJqZXIwMWJiemJucmZtdW14cXYzamxzM2F2N3NxbjMz' \
      --data-urlencode 'grant_type=kyc-otp' \
      --data-urlencode 'username=09132117504' \
      --data-urlencode 'password=75556'
    `);

    expect(request).toMatchObject({
      url: 'http://localhost:8090/oauth2/token',
      method: 'post',
      body: {
        mode: 'formUrlEncoded',
        formUrlEncoded: [
          {
            name: 'grant_type',
            value: 'kyc-otp',
            description: '',
            enabled: true
          },
          {
            name: 'username',
            value: '09132117504',
            description: '',
            enabled: true
          },
          {
            name: 'password',
            value: '75556',
            description: '',
            enabled: true
          }
        ]
      }
    });
  });

  it('should decode escaped form url encoded body values for editing', () => {
    const request = getRequestFromCurlCommand(`
      curl 'https://example.test/token' \
      --header 'Content-Type: application/x-www-form-urlencoded' \
      --data 'name=John+Doe&redirect=https%3A%2F%2Fexample.test%2Fcallback%3Fa%3D1%26b%3D2'
    `);

    expect(request.body.formUrlEncoded).toEqual([
      {
        name: 'name',
        value: 'John Doe',
        description: '',
        enabled: true
      },
      {
        name: 'redirect',
        value: 'https://example.test/callback?a=1&b=2',
        description: '',
        enabled: true
      }
    ]);
  });
});
