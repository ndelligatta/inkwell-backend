// Privy session signer helpers for server-initiated Solana transactions
// This integrates with Privy's server SDK when configured to sign and send
// a prepared (base64) Solana transaction from a user's embedded wallet

let PrivyClient = null;
try {
  // Lazy require to avoid hard crash if package not installed yet
  // Install: npm i @privy-io/server-auth
  ({ PrivyClient } = require('@privy-io/server-auth'));
} catch (e) {
  // Module not available; functions will report a clear error
}

async function signAndSendSolanaTxWithPrivy({ userPrivyId, walletAddress, transactionBase64 }) {
  if (!PrivyClient) {
    throw new Error('Privy server SDK (@privy-io/server-auth) not installed or unavailable');
  }

  const appId = process.env.PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  const authPrivKey = process.env.PRIVY_AUTH_PRIVATE_KEY; // PEM
  const signerId = process.env.PRIVY_SIGNER_QUORUM_ID; // Key quorum id

  if (!appId || !appSecret || !authPrivKey || !signerId) {
    throw new Error('Missing Privy server env: PRIVY_APP_ID, PRIVY_APP_SECRET, PRIVY_AUTH_PRIVATE_KEY, PRIVY_SIGNER_QUORUM_ID');
  }

  const client = new PrivyClient(appId, appSecret, {
    walletApi: {
      authorizationPrivateKey: authPrivKey,
    }
  });

  // Some SDKs require an identityToken (Privy DID). If not, we proceed with signerId and wallet address.
  // Attempt to send Solana transaction via wallet API
  // The exact method name can vary; we try a likely shape and provide a descriptive error otherwise.
  if (!client.walletApi || !client.walletApi.solana) {
    throw new Error('Privy wallet API for Solana is not available in the current SDK');
  }

  const api = client.walletApi.solana;
  if (typeof api.sendTransaction !== 'function') {
    throw new Error('Privy SDK does not expose solana.sendTransaction; please upgrade the server SDK');
  }

  const resp = await api.sendTransaction({
    userId: userPrivyId, // Privy DID
    address: walletAddress,
    transaction: transactionBase64,
    signerId,
    options: {
      commitment: 'confirmed',
      skipPreflight: false,
    },
  });

  return resp; // expect { signature: string, ... }
}

module.exports = {
  signAndSendSolanaTxWithPrivy,
};

