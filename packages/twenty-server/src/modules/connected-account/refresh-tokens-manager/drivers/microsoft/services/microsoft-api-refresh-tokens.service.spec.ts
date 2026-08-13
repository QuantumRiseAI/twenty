import { Test, type TestingModule } from '@nestjs/testing';

import { ConfidentialClientApplication } from '@azure/msal-node';

import { type PlaintextString } from 'src/engine/core-modules/secret-encryption/branded-strings/plaintext-string.type';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { MicrosoftAPIRefreshAccessTokenService } from 'src/modules/connected-account/refresh-tokens-manager/drivers/microsoft/services/microsoft-api-refresh-tokens.service';

jest.mock('@azure/msal-node');

const MockedConfidentialClientApplication =
  ConfidentialClientApplication as jest.MockedClass<
    typeof ConfidentialClientApplication
  >;

describe('MicrosoftAPIRefreshAccessTokenService', () => {
  let service: MicrosoftAPIRefreshAccessTokenService;
  let config: { get: jest.Mock };

  const mockRefreshToken = 'refresh-token' as PlaintextString;

  const buildMsalClientStub = () => ({
    acquireTokenByRefreshToken: jest
      .fn()
      .mockResolvedValue({ accessToken: 'new-access-token' }),
    getTokenCache: jest.fn().mockReturnValue({
      serialize: () =>
        JSON.stringify({
          RefreshToken: {
            'some-cache-key': { secret: 'new-refresh-token' },
          },
        }),
    }),
  });

  const setUp = async (configValues: Record<string, string>) => {
    config = { get: jest.fn((key: string) => configValues[key]) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MicrosoftAPIRefreshAccessTokenService,
        { provide: TwentyConfigService, useValue: config },
      ],
    }).compile();

    service = module.get(MicrosoftAPIRefreshAccessTokenService);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    MockedConfidentialClientApplication.mockImplementation(
      () => buildMsalClientStub() as unknown as ConfidentialClientApplication,
    );
  });

  it('should authenticate against the configured tenant when one is set', async () => {
    await setUp({
      AUTH_MICROSOFT_CLIENT_ID: 'client-id',
      AUTH_MICROSOFT_CLIENT_SECRET: 'client-secret',
      AUTH_MICROSOFT_TENANT_ID: 'a-tenant-id',
    });

    await service.refreshTokens(mockRefreshToken);

    expect(MockedConfidentialClientApplication).toHaveBeenCalledWith({
      auth: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        authority: 'https://login.microsoftonline.com/a-tenant-id',
      },
    });
  });

  // A single-tenant registration created after 15 October 2018 cannot use
  // /common at all (AADSTS50194), so hard-coding it broke refresh for exactly
  // the deployments AUTH_MICROSOFT_TENANT_ID exists to support.
  it('should authenticate against common when the tenant is left at its default', async () => {
    await setUp({
      AUTH_MICROSOFT_CLIENT_ID: 'client-id',
      AUTH_MICROSOFT_CLIENT_SECRET: 'client-secret',
      AUTH_MICROSOFT_TENANT_ID: 'common',
    });

    await service.refreshTokens(mockRefreshToken);

    expect(MockedConfidentialClientApplication).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({
          authority: 'https://login.microsoftonline.com/common',
        }),
      }),
    );
  });

  it('should return the refreshed token pair', async () => {
    await setUp({
      AUTH_MICROSOFT_CLIENT_ID: 'client-id',
      AUTH_MICROSOFT_CLIENT_SECRET: 'client-secret',
      AUTH_MICROSOFT_TENANT_ID: 'a-tenant-id',
    });

    const tokens = await service.refreshTokens(mockRefreshToken);

    expect(tokens).toEqual({
      accessToken: 'new-access-token',
      refreshToken: 'new-refresh-token',
    });
  });
});
