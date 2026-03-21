/**
 * scripts/deploy-test-usdt.js
 *
 * Deploys a minimal TRC-20 test token (TUSDT, 6 decimals) to Shasta testnet.
 *
 * Usage:
 *   cp .env.testnet .env
 *   node scripts/deploy-test-usdt.js
 *
 * Prerequisites:
 *   - .env has TRON_RPC_URL=https://api.shasta.trongrid.io
 *   - Your TRON index-0 address has ≥200 Shasta TRX: https://shasta.tronex.io/
 *
 * The script tries two compile methods in order:
 *   1. solcjs  (install once: npm install -g solc)
 *   2. TronGrid's /wallet/compilesolidity endpoint (no install needed)
 *
 * Output:
 *   Prints the deployed contract address.
 *   Set it as TRON_USDT_CONTRACT in .env.
 */

'use strict';
require('dotenv').config();

const TronWeb = require('tronweb');
const axios   = require('axios');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');

// ---------------------------------------------------------------------------
// Solidity source — pragma 0.5.x for maximum TronGrid compiler compatibility
// ---------------------------------------------------------------------------
const SOLIDITY_SOURCE = `
pragma solidity ^0.5.10;

contract TestUSDT {
    string  public name        = "Test USDT";
    string  public symbol      = "TUSDT";
    uint8   public decimals    = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to,     uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 supply) public {
        totalSupply            = supply * 1000000;
        balanceOf[msg.sender]  = totalSupply;
        emit Transfer(address(0), msg.sender, totalSupply);
    }

    function transfer(address to, uint256 amt) public returns (bool) {
        require(balanceOf[msg.sender] >= amt, "insufficient");
        balanceOf[msg.sender] -= amt;
        balanceOf[to]         += amt;
        emit Transfer(msg.sender, to, amt);
        return true;
    }

    function approve(address spender, uint256 amt) public returns (bool) {
        allowance[msg.sender][spender] = amt;
        emit Approval(msg.sender, spender, amt);
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) public returns (bool) {
        require(balanceOf[from]              >= amt, "insufficient");
        require(allowance[from][msg.sender]  >= amt, "not approved");
        allowance[from][msg.sender] -= amt;
        balanceOf[from]             -= amt;
        balanceOf[to]               += amt;
        emit Transfer(from, to, amt);
        return true;
    }
}
`;

// ---------------------------------------------------------------------------
// Compile via local solcjs  (npm install -g solc)
// ---------------------------------------------------------------------------
function compileLocal() {
  const { execSync } = require('child_process');

  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'tusdt-'));
  const srcFile = path.join(tmpDir, 'TestUSDT.sol');
  fs.writeFileSync(srcFile, SOLIDITY_SOURCE);

  execSync(
    `solcjs --bin --abi --optimize --base-path "${tmpDir}" "${srcFile}"`,
    { cwd: tmpDir, encoding: 'utf8', stdio: 'pipe' },
  );

  const binFile = fs.readdirSync(tmpDir).find(f => f.endsWith('_TestUSDT.bin'));
  const abiFile = fs.readdirSync(tmpDir).find(f => f.endsWith('_TestUSDT.abi'));
  if (!binFile) throw new Error('solcjs produced no .bin output');

  return {
    bytecode: fs.readFileSync(path.join(tmpDir, binFile), 'utf8').trim(),
    abi:      abiFile ? JSON.parse(fs.readFileSync(path.join(tmpDir, abiFile), 'utf8')) : [],
  };
}

// ---------------------------------------------------------------------------
// Compile via TronGrid's server-side compiler  (no install needed)
// ---------------------------------------------------------------------------
async function compileViaTronGrid(rpcUrl, headers) {
  const res = await axios.post(
    `${rpcUrl}/wallet/compilesolidity`,
    { sourceCode: SOLIDITY_SOURCE },
    { headers, timeout: 30_000 },
  );

  const contracts = res.data?.contracts;
  if (!contracts) {
    throw new Error(
      `TronGrid compile returned no contracts.\nResponse: ${JSON.stringify(res.data)}`,
    );
  }

  const key = Object.keys(contracts).find(k => k.includes('TestUSDT'));
  if (!key) throw new Error(`TestUSDT not in compile output. Keys: ${Object.keys(contracts)}`);

  const c = contracts[key];
  return {
    bytecode: c.bytecode,
    abi:      JSON.parse(c.interface ?? c.abi ?? '[]'),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  // --- Validate env ----------------------------------------------------------
  const seed = process.env.WDK_SEED_PHRASE;
  if (!seed) {
    console.error('ERROR: WDK_SEED_PHRASE not set. Run:  cp .env.testnet .env');
    process.exit(1);
  }

  const rpcUrl = process.env.TRON_RPC_URL ?? 'https://api.shasta.trongrid.io';
  const apiKey = process.env.TRON_API_KEY;

  if (!rpcUrl.includes('shasta')) {
    console.error('ERROR: TRON_RPC_URL is not Shasta:', rpcUrl);
    console.error('Run:  cp .env.testnet .env  and check TRON_RPC_URL.');
    process.exit(1);
  }

  const headers    = apiKey ? { 'TRON-PRO-API-KEY': apiKey } : {};
  const account    = TronWeb.fromMnemonic(seed, "m/44'/195'/0'/0/0");
  const privateKey = account.privateKey.replace(/^0x/, '');
  const address    = account.address;

  const tronWeb = new TronWeb({ fullHost: rpcUrl, headers, privateKey });
  tronWeb.setAddress(address);

  console.log('Deployer :', address);
  console.log('RPC      :', rpcUrl);

  const trxSun = await tronWeb.trx.getBalance(address);
  console.log('TRX      :', (trxSun / 1e6).toFixed(3), 'TRX');

  if (trxSun < 200_000_000) {
    console.error('\nNeed ≥200 TRX on Shasta. Get free TRX here:');
    console.error('  https://shasta.tronex.io/  →  paste:', address);
    process.exit(1);
  }

  // --- Compile ---------------------------------------------------------------
  let compiled;

  process.stdout.write('Compiling… ');
  try {
    compiled = compileLocal();
    console.log('(local solcjs)');
  } catch (e1) {
    process.stdout.write('(solcjs unavailable, trying TronGrid)… ');
    try {
      compiled = await compileViaTronGrid(rpcUrl, headers);
      console.log('(TronGrid)');
    } catch (e2) {
      console.error('\nBoth compile methods failed.');
      console.error('Install solcjs:  npm install -g solc');
      console.error('Then retry.');
      console.error('\nsolcjs error :', e1.message);
      console.error('TronGrid error:', e2.message);
      process.exit(1);
    }
  }

  // --- Deploy ----------------------------------------------------------------
  console.log('Deploying TestUSDT with 1,000,000 initial supply…');

  const tx = await tronWeb.transactionBuilder.createSmartContract(
    {
      abi:        compiled.abi,
      bytecode:   compiled.bytecode,
      feeLimit:   500_000_000,   // 500 TRX cap (actual cost ~100-200 TRX on deploy)
      callValue:  0,
      parameters: [1_000_000],   // supply → constructor multiplies by 1e6
      name:       'TestUSDT',
    },
    address,
  );

  const signed = await tronWeb.trx.sign(tx, privateKey);
  const result = await tronWeb.trx.sendRawTransaction(signed);

  if (!result.result) {
    console.error('Deploy rejected:', JSON.stringify(result, null, 2));
    process.exit(1);
  }

  const txId = result.txid;
  console.log('TX broadcast:', txId);
  console.log('Waiting for confirmation (~9s)…');
  await new Promise(r => setTimeout(r, 9000));

  const receipt        = await tronWeb.trx.getTransactionInfo(txId);
  const contractHex    = receipt?.contract_address;
  const contractAddress = contractHex ? TronWeb.address.fromHex(contractHex) : null;

  console.log('');
  if (contractAddress) {
    console.log('══════════════════════════════════════════════════');
    console.log('  TestUSDT deployed!');
    console.log(`  Contract: ${contractAddress}`);
    console.log('══════════════════════════════════════════════════');
    console.log('');
    console.log(`1. Set in .env:   TRON_USDT_CONTRACT=${contractAddress}`);
    console.log(`2. TronScan:      https://shasta.tronscan.org/#/contract/${contractAddress}`);
    console.log(`3. Your address (${address})`);
    console.log('   holds all 1,000,000 TUSDT. Send some to a second wallet');
    console.log('   to simulate a customer payment.');
  } else {
    console.log('TX confirmed but address not indexed yet (normal ~30s lag).');
    console.log('Check TronScan:');
    console.log(`  https://shasta.tronscan.org/#/transaction/${txId}`);
    console.log('Copy the "Contract Address" shown there, then:');
    console.log('  Set in .env:  TRON_USDT_CONTRACT=<address>');
  }
}

main().catch(err => {
  console.error('\nDeploy failed:', err.message ?? err);
  process.exit(1);
});
