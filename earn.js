// Vaulthoric — LI.FI Earn API Client
// Thin wrapper around the LI.FI Earn REST API for vault and portfolio data.

const axios = require('axios');

const EARN_BASE = 'https://earn.li.fi';
const API_KEY   = process.env.LIFI_API_KEY || '';
const HEADERS   = API_KEY ? { 'x-lifi-api-key': API_KEY } : {};

// Fetch all vaults matching the given filters (auto-paginates via cursor).
async function getVaults({ chainId, asset, minTvlUsd = 1000000 } = {}) {
  const allVaults = [];
  let cursor;

  do {
    const params = new URLSearchParams({ limit: '100', sortBy: 'apy' });
    if (chainId)   params.set('chainId',   chainId);
    if (asset)     params.set('asset',     asset);
    if (minTvlUsd) params.set('minTvlUsd', minTvlUsd);
    if (cursor)    params.set('cursor',    cursor);

    const res = await axios.get(`${EARN_BASE}/v1/vaults?${params}`, { headers: HEADERS });
    allVaults.push(...res.data.data);
    cursor = res.data.nextCursor;
  } while (cursor);

  return allVaults;
}

// Fetch a single vault by chain and contract address.
async function getVault(chainId, address) {
  const res = await axios.get(`${EARN_BASE}/v1/vaults/${chainId}/${address}`, { headers: HEADERS });
  return res.data;
}

// Fetch the list of chains supported by LI.FI Earn.
async function getChains() {
  const res = await axios.get(`${EARN_BASE}/v1/chains`, { headers: HEADERS });
  return res.data;
}

// Fetch active vault positions for a given wallet address.
async function getPortfolio(userAddress) {
  const res = await axios.get(`${EARN_BASE}/v1/portfolio/${userAddress}/positions`, { headers: HEADERS });
  return res.data.positions;
}

module.exports = { getVaults, getVault, getChains, getPortfolio };
