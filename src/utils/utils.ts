import axios from "axios";
import {
  Contract,
  solidityPackedKeccak256,
  toBigInt,
  ZeroAddress,
} from "ethers";
import {
  address,
  BASIS_POINTS_DIVISOR,
  DEFAULT_MAX_USDG_AMOUNT,
  FUNDING_RATE_PRECISION,
  GMX_PRICES_ENDPOINT,
  MARGIN_FEE_BASIS_POINTS,
  MAX_PRICE_DEVIATION_BASIS_POINTS,
  PRECISION,
  USDG_ADDRESS,
  USD_DECIMALS,
  PROVIDER,
  TOKENS,
} from "./constants";
import {
  bigintAbs,
  bigintDiv,
  bigintMul,
  bigintMulDiv,
  bigintSub,
  expandDecimals,
  formatAmount,
} from "./numbers";
import { InfoTokens, Position, Token, TokenInfo } from "./types";
import { adapterABI } from "../abis/adapter";
import { factoryABI } from "../abis/factory";
import { readerABI } from "../abis/reader";
import { vaultReaderABI } from "../abis/vaultReader";

function getSpread(p: { minPrice: bigint; maxPrice: bigint }): bigint {
  const diff = p.maxPrice - p.minPrice;
  return bigintMulDiv(diff, PRECISION, bigintDiv(p.maxPrice + p.minPrice, 2));
}

function getDeltaStr({
  delta,
  deltaPercentage,
  hasProfit,
}: {
  delta: bigint;
  deltaPercentage: bigint;
  hasProfit: boolean;
}) {
  let deltaStr;
  let deltaPercentageStr;

  if (delta > 0) {
    deltaStr = hasProfit ? "+" : "-";
    deltaPercentageStr = hasProfit ? "+" : "-";
  } else {
    deltaStr = "";
    deltaPercentageStr = "";
  }
  deltaStr += `$${formatAmount(delta, USD_DECIMALS, 2, true)}`;
  deltaPercentageStr += `${formatAmount(deltaPercentage, 2, 2)}%`;

  return { deltaStr, deltaPercentageStr };
}

function getLeverage({
  size,
  sizeDelta,
  increaseSize,
  collateral,
  collateralDelta,
  increaseCollateral,
  entryFundingRate,
  cumulativeFundingRate,
  hasProfit,
  delta,
  includeDelta,
}: {
  size: bigint;
  sizeDelta?: bigint;
  increaseSize?: boolean;
  collateral: bigint;
  collateralDelta?: bigint;
  increaseCollateral?: boolean;
  entryFundingRate: bigint;
  cumulativeFundingRate?: bigint;
  hasProfit: boolean;
  delta: bigint;
  includeDelta: boolean;
}) {
  if (!size && !sizeDelta) {
    return;
  }
  if (!collateral && !collateralDelta) {
    return;
  }

  let nextSize = size ? size : BigInt(0);
  if (sizeDelta) {
    if (increaseSize) {
      nextSize = size + sizeDelta;
    } else {
      if (sizeDelta >= size) {
        return;
      }
      nextSize = size - sizeDelta;
    }
  }

  let remainingCollateral = collateral ? collateral : BigInt(0);
  if (collateralDelta) {
    if (increaseCollateral) {
      remainingCollateral = collateral + collateralDelta;
    } else {
      if (collateralDelta >= collateral) {
        return;
      }
      remainingCollateral = collateral - collateralDelta;
    }
  }

  if (delta && includeDelta) {
    if (hasProfit) {
      remainingCollateral = remainingCollateral + delta;
    } else {
      if (delta > remainingCollateral) {
        return;
      }

      remainingCollateral = remainingCollateral - delta;
    }
  }

  if (remainingCollateral === BigInt(0)) {
    return;
  }

  remainingCollateral = sizeDelta
    ? bigintDiv(
        bigintMul(
          remainingCollateral,
          BASIS_POINTS_DIVISOR - MARGIN_FEE_BASIS_POINTS
        ),
        BASIS_POINTS_DIVISOR
      )
    : remainingCollateral;
  if (entryFundingRate && cumulativeFundingRate) {
    const fundingFee = bigintDiv(
      bigintMul(size, cumulativeFundingRate - entryFundingRate),
      FUNDING_RATE_PRECISION
    );
    remainingCollateral = remainingCollateral - fundingFee;
  }

  return bigintMulDiv(nextSize, BASIS_POINTS_DIVISOR, remainingCollateral);
}

function getLeverageStr(leverage: bigint | undefined) {
  if (leverage) {
    if (leverage < 0) {
      return "> 100x";
    }
    return `${formatAmount(leverage, 4, 2, true)}x`;
  }
}

function getPositionKeyWithAdapter(
  account: string,
  collateralTokenAddress: string,
  indexTokenAddress: string,
  adapter: string,
  isLong: boolean,
  nativeTokenAddress?: string
) {
  const tokenAddress0 =
    collateralTokenAddress === ZeroAddress
      ? nativeTokenAddress
      : collateralTokenAddress;
  const tokenAddress1 =
    indexTokenAddress === ZeroAddress ? nativeTokenAddress : indexTokenAddress;
  return (
    account +
    ":" +
    adapter +
    ":" +
    tokenAddress0 +
    ":" +
    tokenAddress1 +
    ":" +
    isLong
  );
}

function getTokenInfo(
  infoTokens: InfoTokens,
  tokenAddress: string,
  replaceNative?: boolean,
  nativeTokenAddress?: string
) {
  if (replaceNative && tokenAddress === nativeTokenAddress) {
    return infoTokens[ZeroAddress];
  }

  return infoTokens[tokenAddress];
}

function getPositionContractKey(
  account: string,
  collateralToken: string,
  indexToken: string,
  isLong: boolean
) {
  return solidityPackedKeccak256(
    ["address", "address", "address", "bool"],
    [account, collateralToken, indexToken, isLong]
  );
}

function getPositionKey(
  account: string,
  collateralTokenAddress: string,
  indexTokenAddress: string,
  isLong: boolean,
  nativeTokenAddress?: string
) {
  const tokenAddress0 =
    collateralTokenAddress === ZeroAddress
      ? nativeTokenAddress
      : collateralTokenAddress;
  const tokenAddress1 =
    indexTokenAddress === ZeroAddress ? nativeTokenAddress : indexTokenAddress;
  return account + ":" + tokenAddress0 + ":" + tokenAddress1 + ":" + isLong;
}

function getFundingFee(data: {
  size: bigint;
  entryFundingRate?: bigint;
  cumulativeFundingRate?: bigint;
}) {
  let { entryFundingRate, cumulativeFundingRate, size } = data;

  if (entryFundingRate && cumulativeFundingRate) {
    return bigintMulDiv(
      size,
      cumulativeFundingRate - entryFundingRate,
      FUNDING_RATE_PRECISION
    );
  }

  return;
}

const derivePositions = (
  positions: Position[],
  account: string,
  showPnlAfterFees: boolean,
  includeDelta: boolean
) => {
  let derivedPositions: Position[] = [];

  const positionsMap: Record<string, Position> = {};

  for (let i = 0; i < positions.length; i++) {
    let position = positions[i];
    const key = getPositionKey(
      account,
      position.collateralToken.address,
      position.indexToken.address,
      position.isLong,
      address.tokens.ETH
    );

    const adapterKey = getPositionKeyWithAdapter(
      account,
      position.collateralToken.address,
      position.indexToken.address,
      position.adapter,
      position.isLong,
      address.tokens.ETH
    );

    position.key = key;
    position.adapterKey = adapterKey;

    let fundingFee = getFundingFee(position);
    position.fundingFee = fundingFee ? fundingFee : BigInt(0);
    position.collateralAfterFee = position.fundingFee
      ? position.collateral - position.fundingFee
      : position.collateral;

    position.closingFee = bigintMulDiv(
      position.size,
      MARGIN_FEE_BASIS_POINTS,
      BASIS_POINTS_DIVISOR
    );
    position.positionFee = bigintMulDiv(
      bigintMul(position.size, MARGIN_FEE_BASIS_POINTS),
      2,
      BASIS_POINTS_DIVISOR
    );
    position.totalFees = position.fundingFee
      ? position.positionFee + position.fundingFee
      : position.positionFee;

    position.pendingDelta = position.delta;

    if (position.collateral > 0) {
      position.hasLowCollateral =
        position.collateralAfterFee < 0 ||
        bigintDiv(position.size, bigintAbs(position.collateralAfterFee)) > 50;

      if (position.averagePrice && position.markPrice) {
        const priceDelta =
          position.averagePrice > position.markPrice
            ? position.averagePrice - position.markPrice
            : position.markPrice - position.averagePrice;
        position.pendingDelta =
          (position.size * priceDelta) / position.averagePrice;

        position.delta = position.pendingDelta;

        if (position.isLong) {
          position.hasProfit = position.markPrice >= position.averagePrice;
        } else {
          position.hasProfit = position.markPrice <= position.averagePrice;
        }
      }

      position.deltaPercentage = bigintMulDiv(
        position.pendingDelta,
        BASIS_POINTS_DIVISOR,
        position.collateral
      );

      const { deltaStr, deltaPercentageStr } = getDeltaStr({
        delta: position.pendingDelta,
        deltaPercentage: position.deltaPercentage,
        hasProfit: position.hasProfit,
      });

      position.deltaStr = deltaStr;
      position.deltaPercentageStr = deltaPercentageStr;
      position.deltaBeforeFeesStr = deltaStr;

      let hasProfitAfterFees;
      let pendingDeltaAfterFees;

      if (position.hasProfit) {
        if (position.pendingDelta > position.totalFees) {
          hasProfitAfterFees = true;
          pendingDeltaAfterFees = position.pendingDelta - position.totalFees;
        } else {
          hasProfitAfterFees = false;
          pendingDeltaAfterFees = position.totalFees - position.pendingDelta;
        }
      } else {
        hasProfitAfterFees = false;
        pendingDeltaAfterFees = position.pendingDelta + position.totalFees;
      }

      position.hasProfitAfterFees = hasProfitAfterFees;
      position.pendingDeltaAfterFees = pendingDeltaAfterFees;
      // while calculating delta percentage after fees, we need to add opening fee (which is equal to closing fee) to collateral
      position.deltaPercentageAfterFees = bigintMulDiv(
        position.pendingDeltaAfterFees || 0,
        BASIS_POINTS_DIVISOR,
        position.collateral + position.closingFee
      );

      const {
        deltaStr: deltaAfterFeesStr,
        deltaPercentageStr: deltaAfterFeesPercentageStr,
      } = getDeltaStr({
        delta: position.pendingDeltaAfterFees || toBigInt(0),
        deltaPercentage: position.deltaPercentageAfterFees,
        hasProfit: hasProfitAfterFees,
      });

      position.deltaAfterFeesStr = deltaAfterFeesStr;
      position.deltaAfterFeesPercentageStr = deltaAfterFeesPercentageStr;

      if (showPnlAfterFees) {
        position.deltaStr = position.deltaAfterFeesStr;
        position.deltaPercentageStr = position.deltaAfterFeesPercentageStr;
      }

      let netValue = position.hasProfit
        ? position.collateral + position.pendingDelta
        : position.collateral - position.pendingDelta;

      netValue = position.fundingFee
        ? netValue - position.fundingFee - position.closingFee
        : netValue;
      position.netValue = netValue;
    }

    position.leverage = getLeverage({
      size: position.size,
      collateral: position.collateral,
      entryFundingRate: position.entryFundingRate,
      cumulativeFundingRate: position.cumulativeFundingRate,
      hasProfit: position.hasProfit,
      delta: position.delta,
      includeDelta,
    });
    position.leverageStr = getLeverageStr(position.leverage);

    derivedPositions.push(position);
    positionsMap[adapterKey] = position;
  }

  return { derivedPositions, positionsMap };
};

async function getInfoTokensFromReader(account: string) {
  const tokens = TOKENS["arbitrum"];
  const vaultReaderAddress = address.contracts.GMX_VAULT_READER;
  const vaultAddress = address.contracts.GMX_VAULT;
  const positionRouterAddress = address.contracts.GMX_POSITION_ROUTER;
  const nativeTokenAddress = address.tokens.ETH;
  const readerAddress = address.contracts.GMX_READER;

  const whitelistedTokens = TOKENS["arbitrum"];
  const whitelistedTokenAddresses = TOKENS["arbitrum"].map((x) => x.address); // derive from tokens

  let contract = new Contract(vaultReaderAddress, vaultReaderABI, PROVIDER);
  const vaultTokenInfo: bigint[] = await contract["getVaultTokenInfoV4"](
    vaultAddress,
    positionRouterAddress,
    nativeTokenAddress,
    expandDecimals(1, 18),
    whitelistedTokenAddresses
  );

  const indexPrices: { [address: string]: bigint } = await axios.get(
    GMX_PRICES_ENDPOINT
  );

  contract = new Contract(readerAddress, readerABI, PROVIDER);
  const tokenBalances = await contract["getTokenBalances"](
    account,
    whitelistedTokenAddresses
  );

  const fundingRateInfo = await contract["getFundingRates"](
    vaultAddress,
    nativeTokenAddress,
    whitelistedTokenAddresses
  );

  return getInfoTokens(
    tokens,
    tokenBalances,
    whitelistedTokens,
    vaultTokenInfo,
    fundingRateInfo,
    indexPrices,
    nativeTokenAddress
  );
}

function getInfoTokens(
  tokens: Token[],
  tokenBalances: readonly bigint[] | undefined,
  whitelistedTokens: Token[],
  vaultTokenInfo: readonly bigint[] | undefined,
  fundingRateInfo: readonly bigint[] | undefined,
  indexPrices: { [address: string]: bigint },
  nativeTokenAddress: string,
  vaultPropsLength?: number
): InfoTokens {
  if (!vaultPropsLength) vaultPropsLength = 15;

  const fundingRatePropsLength = 2;
  const infoTokens: InfoTokens = {};

  for (let i = 0; i < tokens.length; i++) {
    const token = JSON.parse(JSON.stringify(tokens[i])) as TokenInfo;

    if (tokenBalances) {
      token.balance = tokenBalances[i];
    }

    if (token.address === USDG_ADDRESS) {
      token.minPrice = expandDecimals(1, USD_DECIMALS);
      token.maxPrice = expandDecimals(1, USD_DECIMALS);
    }

    infoTokens[token.address] = token;
  }

  for (let i = 0; i < whitelistedTokens.length; i++) {
    const token = JSON.parse(JSON.stringify(whitelistedTokens[i])) as TokenInfo;

    if (vaultTokenInfo) {
      token.poolAmount = vaultTokenInfo[i * vaultPropsLength];
      token.reservedAmount = vaultTokenInfo[i * vaultPropsLength + 1];
      token.availableAmount = token.poolAmount - token.reservedAmount;
      token.usdgAmount = vaultTokenInfo[i * vaultPropsLength + 2];
      token.redemptionAmount = vaultTokenInfo[i * vaultPropsLength + 3];
      token.weight = vaultTokenInfo[i * vaultPropsLength + 4];
      token.bufferAmount = vaultTokenInfo[i * vaultPropsLength + 5];
      token.maxUsdgAmount = vaultTokenInfo[i * vaultPropsLength + 6];
      token.globalShortSize = vaultTokenInfo[i * vaultPropsLength + 7];
      token.maxGlobalShortSize = vaultTokenInfo[i * vaultPropsLength + 8];
      token.maxGlobalLongSize = vaultTokenInfo[i * vaultPropsLength + 9];
      token.minPrice = vaultTokenInfo[i * vaultPropsLength + 10];
      token.maxPrice = vaultTokenInfo[i * vaultPropsLength + 11];
      token.spread = getSpread({
        minPrice: token.minPrice,
        maxPrice: token.maxPrice,
      });
      token.guaranteedUsd = vaultTokenInfo[i * vaultPropsLength + 12];
      token.maxPrimaryPrice = vaultTokenInfo[i * vaultPropsLength + 13];
      token.minPrimaryPrice = vaultTokenInfo[i * vaultPropsLength + 14];

      // save minPrice and maxPrice as setTokenUsingIndexPrices may override it
      token.contractMinPrice = token.minPrice;
      token.contractMaxPrice = token.maxPrice;

      token.maxAvailableShort = BigInt(0);

      token.hasMaxAvailableShort = false;
      if (token.maxGlobalShortSize > 0) {
        token.hasMaxAvailableShort = true;
        if (token.maxGlobalShortSize > token.globalShortSize) {
          token.maxAvailableShort =
            token.maxGlobalShortSize - token.globalShortSize;
        }
      }

      if (token.maxUsdgAmount && token.maxUsdgAmount === BigInt(0)) {
        token.maxUsdgAmount = DEFAULT_MAX_USDG_AMOUNT;
      }

      token.availableUsd = token.isStable
        ? (token.poolAmount * token.minPrice) /
          expandDecimals(1, token.decimals)
        : (token.availableAmount * token.minPrice) /
          expandDecimals(1, token.decimals);

      token.maxAvailableLong = BigInt(0)!;
      token.hasMaxAvailableLong = false;
      if (token.maxGlobalLongSize > 0) {
        token.hasMaxAvailableLong = true;

        if (token.maxGlobalLongSize > token.guaranteedUsd) {
          const remainingLongSize =
            token.maxGlobalLongSize - token.guaranteedUsd;
          token.maxAvailableLong =
            remainingLongSize < token.availableUsd
              ? remainingLongSize
              : token.availableUsd;
        }
      } else {
        token.maxAvailableLong = token.availableUsd;
      }

      token.maxLongCapacity =
        token.maxGlobalLongSize > 0 &&
        token.maxGlobalLongSize < token.availableUsd + token.guaranteedUsd
          ? token.maxGlobalLongSize
          : token.availableUsd + token.guaranteedUsd;

      token.managedUsd = token.availableUsd + token.guaranteedUsd;
      token.managedAmount =
        (token.managedUsd * expandDecimals(1, token.decimals)) / token.minPrice;

      setTokenUsingIndexPrices(token, indexPrices, nativeTokenAddress);
    }

    if (fundingRateInfo) {
      token.fundingRate = fundingRateInfo[i * fundingRatePropsLength];
      token.cumulativeFundingRate =
        fundingRateInfo[i * fundingRatePropsLength + 1];
    }

    if (infoTokens[token.address]) {
      token.balance = infoTokens[token.address].balance;
    }

    infoTokens[token.address] = token;
  }

  return infoTokens;
}

function setTokenUsingIndexPrices(
  token: TokenInfo,
  indexPrices: { [address: string]: bigint },
  nativeTokenAddress: string
) {
  if (!indexPrices) {
    return;
  }

  const tokenAddress = token.isNative ? nativeTokenAddress : token.address;

  const indexPrice = indexPrices[tokenAddress];

  if (!indexPrice) {
    return;
  }

  const indexPriceBn = BigInt(indexPrice)!;

  if (indexPriceBn === BigInt(0)) {
    return;
  }

  const spread = token.maxPrice! - token.minPrice!;
  const spreadBps = spread;
  bigintMulDiv(
    spread,
    BASIS_POINTS_DIVISOR,
    bigintDiv(token.maxPrice! + token.minPrice!, 2)
  );

  if (spreadBps > bigintSub(MAX_PRICE_DEVIATION_BASIS_POINTS, 50)) {
    // only set one of the values as there will be a spread between the index price and the Chainlink price
    if (indexPriceBn > token.minPrimaryPrice!) {
      token.maxPrice = indexPriceBn;
    } else {
      token.minPrice = indexPriceBn;
    }
    return;
  }

  const halfSpreadBps = Number(bigintDiv(spreadBps, 2));
  token.maxPrice = indexPriceBn;
  bigintMulDiv(
    indexPriceBn,
    BASIS_POINTS_DIVISOR + halfSpreadBps,
    BASIS_POINTS_DIVISOR
  );
  token.minPrice = indexPriceBn;
  bigintMulDiv(
    indexPriceBn,
    BASIS_POINTS_DIVISOR - halfSpreadBps,
    BASIS_POINTS_DIVISOR
  );
}

export const getPositions = async (
  account: string,
  showlPnlAfterFees: boolean,
  isPnlInLeverage: boolean
) => {
  const factoryAddress = address.contracts.GMX_FACTORY_ADDRESS;
  const contract = new Contract(factoryAddress, factoryABI, PROVIDER);
  const infoTokens = await getInfoTokensFromReader(account);
  const count = await contract["getTotalPositions"](account);
  const idsFetch = [];
  for (let i = 1; i <= count; i++)
    idsFetch.push(contract["getPositionId"](account, i));
  const ids = await Promise.all(idsFetch);
  const positions = await Promise.all(
    ids.map((id) => contract["getPosition"](id))
  );
  const adapters = await Promise.all(
    ids.map((id) => contract["positionAdapters"](id))
  );
  const requestDataFetch: Promise<any>[] = [];
  adapters.forEach((adapter) => {
    const contract = new Contract(adapter, adapterABI, PROVIDER);
    requestDataFetch.push(contract["getPositionData"]());
  });
  const requestData = await Promise.all(requestDataFetch);

  let ret: any = [];
  let positionIds: string[] = [];

  for (let i = 0; i < count; i++) {
    // Only add the positionId if it's not already in the array
    if (!positionIds.includes(ids[i])) {
      positionIds.push(ids[i]);

      const isLong = requestData[i][6];

      const collateralToken = getTokenInfo(
        infoTokens,
        requestData[i][1],
        true,
        address.tokens.ETH
      );
      const indexToken = getTokenInfo(
        infoTokens,
        requestData[i][2],
        true,
        address.tokens.ETH
      );

      const markPrice = isLong ? indexToken.minPrice : indexToken.maxPrice;
      // console.log("mark p", markPrice)

      const adapter = adapters[i];
      let contractKey = getPositionContractKey(
        adapter,
        requestData[i][1],
        requestData[i][2],
        isLong
      );

      let positionInfo = {
        positionId: ids[i],
        adapter,
        contractKey,
        collateralToken,
        indexToken,
        isLong,
        size: positions[i][0],
        collateral: positions[i][1],
        averagePrice: positions[i][2],
        entryFundingRate: positions[i][3],
        cumulativeFundingRate: collateralToken.cumulativeFundingRate,
        hasRealisedProfit: positions[i][4],
        realisedPnl: positions[i][5],
        lastIncreasedTime: positions[i][6],
        hasProfit: positions[i][7],
        delta: positions[i][8],
        markPrice,
      };
      ret.push(positionInfo);
    }
  }

  const { derivedPositions } = derivePositions(
    ret,
    account,
    showlPnlAfterFees,
    isPnlInLeverage
  );

  return derivedPositions;
};
