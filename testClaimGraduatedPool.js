// Test script to claim fees from graduated pool
const { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const { CpAmm } = require('@meteora-ag/cp-amm-sdk');
const bs58 = require('bs58').default;
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } = require('@solana/spl-token');

// Constants
const GRADUATED_POOL_ADDRESS = "HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC";
const CONFIG_PRIVATE_KEY = "3CdTuDY6Pyi4AeAx79ZDQyD39QtZHjqrwv1epLZM1X72c8ES5TAF2JSh5YGxUMs8bUehYMP37JW2ZHNRjhosiDM6";
const HELIUS_API_KEY = "726140d8-6b0d-4719-8702-682d81e94a37";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// Helper to determine token program
function getTokenProgram(tokenFlag) {
  return tokenFlag === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
}

// Helper function to retry RPC calls
async function retryRpcCall(fn, maxRetries = 3, delayMs = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      console.log(`RPC call attempt ${i + 1} failed:`, error.message);
      if (i === maxRetries - 1) throw error;
      console.log(`Retrying in ${delayMs}ms...`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
}

async function claimGraduatedPoolFees() {
  try {
    console.log('====== TEST CLAIM GRADUATED POOL FEES ======');
    console.log('Pool:', GRADUATED_POOL_ADDRESS);
    console.log('');

    // Initialize connection
    const connection = new Connection(RPC_URL, {
      commitment: 'confirmed',
      confirmTransactionInitialTimeout: 60000,
      httpHeaders: {
        'solana-client': 'inkwell-test-claim'
      }
    });

    // Create keypair from config private key
    const configKeypair = Keypair.fromSecretKey(bs58.decode(CONFIG_PRIVATE_KEY));
    console.log('Config wallet (claimer):', configKeypair.publicKey.toString());

    // Check wallet balance
    const balance = await retryRpcCall(
      () => connection.getBalance(configKeypair.publicKey),
      3,
      2000
    );
    console.log('Config wallet balance:', (balance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');

    if (balance < 0.01 * LAMPORTS_PER_SOL) {
      throw new Error('Config wallet needs at least 0.01 SOL for transaction fees');
    }

    // Initialize CP AMM client
    const cpAmm = new CpAmm(connection);
    const poolPubkey = new PublicKey(GRADUATED_POOL_ADDRESS);

    // Get pool state
    console.log('\nFetching pool state...');
    const poolState = await retryRpcCall(
      () => cpAmm.fetchPoolState(poolPubkey),
      3,
      2000
    );
    
    console.log('Pool state fetched!');
    console.log('Token A:', poolState.tokenAMint.toString());
    console.log('Token B:', poolState.tokenBMint.toString());
    console.log('Token A Vault:', poolState.tokenAVault.toString());
    console.log('Token B Vault:', poolState.tokenBVault.toString());
    console.log('Protocol Fee Rate:', poolState.protocolFeeRate);

    // Check if this is a partner pool and get fee info
    console.log('\nChecking pool fee configuration...');
    console.log('Config ID:', poolState.configId?.toString());
    console.log('Authority:', poolState.authority?.toString());

    // Find all positions for this pool owned by config wallet
    console.log('\nFinding positions for config wallet...');
    const userPositions = await retryRpcCall(
      () => cpAmm.getUserPositionByPool(
        poolPubkey,
        configKeypair.publicKey
      ),
      3,
      2000
    );

    if (!userPositions || userPositions.length === 0) {
      console.log('No positions found for config wallet');
      
      // Try to check if there are protocol fees to claim directly
      console.log('\nChecking for protocol fees to claim...');
      
      // Get token vault balances
      const tokenABalance = await retryRpcCall(
        () => connection.getTokenAccountBalance(poolState.tokenAVault),
        3,
        2000
      );
      const tokenBBalance = await retryRpcCall(
        () => connection.getTokenAccountBalance(poolState.tokenBVault),
        3,
        2000
      );
      
      console.log('Token A Vault balance:', tokenABalance.value.uiAmount);
      console.log('Token B Vault balance:', tokenBBalance.value.uiAmount);

      // Try to claim protocol fees
      console.log('\nAttempting to claim protocol fees...');
      try {
        const claimProtocolFeeTx = await cpAmm.claimProtocolFee({
          owner: configKeypair.publicKey,
          authority: configKeypair.publicKey,
          pool: poolPubkey,
          tokenAVault: poolState.tokenAVault,
          tokenBVault: poolState.tokenBVault,
          tokenAMint: poolState.tokenAMint,
          tokenBMint: poolState.tokenBMint,
          tokenAProgram: getTokenProgram(poolState.tokenAFlag),
          tokenBProgram: getTokenProgram(poolState.tokenBFlag),
        });

        // Set fee payer and blockhash
        claimProtocolFeeTx.feePayer = configKeypair.publicKey;
        const { blockhash } = await retryRpcCall(
          () => connection.getLatestBlockhash('confirmed'),
          3,
          2000
        );
        claimProtocolFeeTx.recentBlockhash = blockhash;

        // Sign and send
        claimProtocolFeeTx.sign(configKeypair);
        
        console.log('Sending protocol fee claim transaction...');
        const signature = await retryRpcCall(
          () => connection.sendRawTransaction(
            claimProtocolFeeTx.serialize(),
            {
              skipPreflight: false,
              preflightCommitment: 'confirmed',
              maxRetries: 3
            }
          ),
          3,
          2000
        );

        console.log('Transaction sent:', signature);
        console.log('Waiting for confirmation...');

        const confirmation = await retryRpcCall(
          () => connection.confirmTransaction(signature, 'confirmed'),
          3,
          2000
        );

        if (confirmation.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
        }

        console.log('✅ Protocol fees claimed!');
        console.log('View on Solscan:', `https://solscan.io/tx/${signature}`);
        
        return;
      } catch (protocolFeeError) {
        console.error('Protocol fee claim failed:', protocolFeeError.message);
      }
    } else {
      console.log(`Found ${userPositions.length} positions`);

      // Claim fees from each position
      for (let i = 0; i < userPositions.length; i++) {
        const position = userPositions[i];
        console.log(`\nProcessing position ${i + 1}/${userPositions.length}...`);
        console.log('Position:', position.position?.toString());
        console.log('Position NFT:', position.positionNftAccount?.toString());

        try {
          // Create claim transaction
          const claimPositionFeesTx = await cpAmm.claimPositionFee2({
            receiver: configKeypair.publicKey,
            owner: configKeypair.publicKey,
            pool: poolPubkey,
            position: position.position,
            positionNftAccount: position.positionNftAccount,
            tokenAVault: poolState.tokenAVault,
            tokenBVault: poolState.tokenBVault,
            tokenAMint: poolState.tokenAMint,
            tokenBMint: poolState.tokenBMint,
            tokenAProgram: getTokenProgram(poolState.tokenAFlag),
            tokenBProgram: getTokenProgram(poolState.tokenBFlag),
            feePayer: configKeypair.publicKey,
          });

          // Set fee payer and blockhash
          claimPositionFeesTx.feePayer = configKeypair.publicKey;
          const { blockhash } = await retryRpcCall(
            () => connection.getLatestBlockhash('confirmed'),
            3,
            2000
          );
          claimPositionFeesTx.recentBlockhash = blockhash;

          // Sign and send
          claimPositionFeesTx.sign(configKeypair);
          
          console.log('Sending position fee claim transaction...');
          const signature = await retryRpcCall(
            () => connection.sendRawTransaction(
              claimPositionFeesTx.serialize(),
              {
                skipPreflight: false,
                preflightCommitment: 'confirmed',
                maxRetries: 3
              }
            ),
            3,
            2000
          );

          console.log('Transaction sent:', signature);
          console.log('Waiting for confirmation...');

          const confirmation = await retryRpcCall(
            () => connection.confirmTransaction(signature, 'confirmed'),
            3,
            2000
          );

          if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
          }

          console.log('✅ Position fees claimed!');
          console.log('View on Solscan:', `https://solscan.io/tx/${signature}`);

        } catch (positionError) {
          console.error(`Error claiming position ${i + 1}:`, positionError.message);
        }
      }
    }

    // Check final balance
    const finalBalance = await retryRpcCall(
      () => connection.getBalance(configKeypair.publicKey),
      3,
      2000
    );
    console.log('\nFinal config wallet balance:', (finalBalance / LAMPORTS_PER_SOL).toFixed(6), 'SOL');
    console.log('Balance change:', ((finalBalance - balance) / LAMPORTS_PER_SOL).toFixed(6), 'SOL');

  } catch (error) {
    console.error('\n❌ ERROR:', error);
    console.error('Stack:', error.stack);
  }
}

// Run the test
console.log('Starting graduated pool fee claim test...\n');
claimGraduatedPoolFees()
  .then(() => {
    console.log('\nTest completed!');
    process.exit(0);
  })
  .catch(error => {
    console.error('\nTest failed:', error);
    process.exit(1);
  });