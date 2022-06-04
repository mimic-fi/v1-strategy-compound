import {
  advanceTime,
  assertEvent,
  bn,
  deploy,
  fp,
  getSigners,
  impersonateWhale,
  instanceAt,
  MONTH,
} from '@mimic-fi/v1-helpers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
import { expect } from 'chai'
import { BigNumber, Contract } from 'ethers'

/* eslint-disable no-secrets/no-secrets */

const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const CDAI = '0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const COMP = '0xc00e94cb662c3520282e6f5717214004a7f26888'

const UNISWAP_V2_ROUTER = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'
const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564'
const BALANCER_V2_VAULT = '0xBA12222222228d8Ba445958a75a0704d566BF2C8'

const CHAINLINK_ORACLE_DAI_ETH = '0x773616E4d11A78F511299002da57A0a94577F1f4'
const CHAINLINK_ORACLE_USDC_ETH = '0x986b5E1e1755e3C2440e960477f25201B0a8bbD4'
const CHAINLINK_ORACLE_COMP_ETH = '0x1b39ee86ec5979ba5c322b826b3ecb8c79991699'

describe('CompoundStrategy - DAI', function () {
  let whale: SignerWithAddress, owner: SignerWithAddress
  let vault: Contract, strategy: Contract, dai: Contract, cdai: Contract, usdc: Contract

  const SLIPPAGE = fp(0.01)
  const JOIN_AMOUNT = fp(50)

  const expectWithError = (actual: BigNumber, expected: BigNumber) => {
    expect(actual).to.be.at.least(bn(expected).sub(1))
    expect(actual).to.be.at.most(bn(expected).add(1))
  }

  before('load signers', async () => {
    // eslint-disable-next-line prettier/prettier
    [, owner] = await getSigners()
    whale = await impersonateWhale(fp(100))
  })

  before('deploy vault', async () => {
    const maxSlippage = fp(0.02)
    const protocolFee = fp(0.00003)
    const whitelistedTokens: string[] = []
    const whitelistedStrategies: string[] = []
    const priceOracleTokens: string[] = [DAI, USDC, COMP]
    const priceOracleFeeds: string[] = [CHAINLINK_ORACLE_DAI_ETH, CHAINLINK_ORACLE_USDC_ETH, CHAINLINK_ORACLE_COMP_ETH]

    const priceOracle = await deploy(
      '@mimic-fi/v1-chainlink-price-oracle/artifacts/contracts/ChainLinkPriceOracle.sol/ChainLinkPriceOracle',
      [priceOracleTokens, priceOracleFeeds]
    )

    const swapConnector = await deploy(
      '@mimic-fi/v1-swap-connector/artifacts/contracts/SwapConnector.sol/SwapConnector',
      [priceOracle.address, UNISWAP_V3_ROUTER, UNISWAP_V2_ROUTER, BALANCER_V2_VAULT]
    )

    vault = await deploy('@mimic-fi/v1-vault/artifacts/contracts/Vault.sol/Vault', [
      maxSlippage,
      protocolFee,
      priceOracle.address,
      swapConnector.address,
      whitelistedTokens,
      whitelistedStrategies,
    ])
  })

  before('deploy strategy', async () => {
    const factory = await deploy('CompoundStrategyFactory', [vault.address])
    const createTx = await factory.connect(owner).create(DAI, CDAI, SLIPPAGE, 'metadata:uri')
    const { args } = await assertEvent(createTx, 'StrategyCreated')
    strategy = await instanceAt('CompoundStrategy', args.strategy)
  })

  before('load tokens', async () => {
    dai = await instanceAt('IERC20', DAI)
    cdai = await instanceAt('ICToken', CDAI)
    usdc = await instanceAt('IERC20', USDC)
  })

  before('deposit tokens', async () => {
    await dai.connect(whale).approve(vault.address, fp(100))
    await vault.connect(whale).deposit(whale.address, dai.address, fp(100), '0x')
  })

  it('deploys the strategy correctly', async () => {
    expect(await strategy.getVault()).to.be.equal(vault.address)
    expect(await strategy.getToken()).to.be.equal(dai.address)
    expect(await strategy.getCToken()).to.be.equal(cdai.address)
    expect(await strategy.getSlippage()).to.be.equal(SLIPPAGE)
    expect(await strategy.getMetadataURI()).to.be.equal('metadata:uri')
    expect(await strategy.getTotalValue()).to.be.equal(0)
    expect(await strategy.getValueRate()).to.be.equal(fp(1))
    expect(await strategy.owner()).to.be.equal(owner.address)
  })

  it('allows the owner to set a new metadata', async () => {
    const newMetadata = 'metadata:uri:2.0'

    await strategy.connect(owner).setMetadataURI(newMetadata)
    expect(await strategy.getMetadataURI()).to.be.equal(newMetadata)

    await expect(strategy.setMetadataURI(newMetadata)).to.be.revertedWith('Ownable: caller is not the owner')
  })

  it('allows the owner to set a new slippage', async () => {
    const currentSlippage = await strategy.getSlippage()
    const newSlippage = currentSlippage.add(1)

    await strategy.connect(owner).setSlippage(newSlippage)
    expect(await strategy.getSlippage()).to.be.equal(newSlippage)

    await expect(strategy.setSlippage(newSlippage)).to.be.revertedWith('Ownable: caller is not the owner')
  })

  it('joins the strategy', async () => {
    const previousVaultBalance = await dai.balanceOf(vault.address)
    expect(previousVaultBalance).to.be.equal(fp(100))

    const previousStrategyBalance = await dai.balanceOf(strategy.address)
    expect(previousStrategyBalance).to.be.equal(0)

    await vault.connect(whale).join(whale.address, strategy.address, JOIN_AMOUNT, '0x')

    const currentVaultBalance = await dai.balanceOf(vault.address)
    expect(currentVaultBalance).to.be.equal(previousVaultBalance.sub(JOIN_AMOUNT))

    const currentStrategyBalance = await dai.balanceOf(strategy.address)
    expect(currentStrategyBalance).to.be.equal(previousStrategyBalance)

    const cDaiRate = await cdai.exchangeRateStored()
    const cDaiBalance = await cdai.balanceOf(strategy.address)
    const expectedValue = cDaiBalance.mul(cDaiRate).div(fp(1))
    const { invested, shares } = await vault.getAccountInvestment(whale.address, strategy.address)
    expectWithError(invested, expectedValue)
    expectWithError(shares, expectedValue)

    const strategyShares = await vault.getStrategyShares(strategy.address)
    expectWithError(shares, strategyShares)

    const strategyShareValue = await vault.getStrategyShareValue(strategy.address)
    const accountValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expectWithError(accountValue, strategyShares.mul(strategyShareValue).div(fp(1)))
  })

  it('accrues value over time', async () => {
    const previousValue = await vault.getAccountCurrentValue(whale.address, strategy.address)

    await advanceTime(MONTH)
    await cdai.exchangeRateCurrent()
    await strategy.claimAndInvest()

    const currentValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expect(currentValue).to.be.gt(previousValue)
  })

  it('exits with a 50%', async () => {
    const previousBalance = await vault.getAccountBalance(whale.address, dai.address)
    const previousInvestment = await vault.getAccountInvestment(whale.address, strategy.address)

    const exitRatio = fp(0.5)
    await vault.connect(whale).exit(whale.address, strategy.address, exitRatio, false, '0x')

    // The user should at least have some gains
    const currentBalance = await vault.getAccountBalance(whale.address, dai.address)
    expect(currentBalance).to.be.gt(previousBalance)

    // There should not be any remaining tokens in the strategy
    const currentStrategyBalance = await dai.balanceOf(strategy.address)
    expect(currentStrategyBalance).to.be.equal(0)

    const cDaiRate = await cdai.exchangeRateStored()
    const cDaiBalance = await cdai.balanceOf(strategy.address)
    const expectedValue = cDaiBalance.mul(cDaiRate).div(fp(1))
    const currentInvestment = await vault.getAccountInvestment(whale.address, strategy.address)
    expectWithError(currentInvestment.invested, expectedValue)
    expectWithError(currentInvestment.shares, previousInvestment.shares.mul(fp(1).sub(exitRatio)).div(fp(1)))

    const strategyShares = await vault.getStrategyShares(strategy.address)
    expectWithError(strategyShares, currentInvestment.shares)

    // TODO: Review rounding issue
    const accountValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    const strategyShareValue = await vault.getStrategyShareValue(strategy.address)
    const expectedAccountValue = strategyShares.mul(strategyShareValue).div(fp(1))
    expect(accountValue).to.be.at.least(bn(expectedAccountValue).sub(50))
    expect(accountValue).to.be.at.most(bn(expectedAccountValue).add(50))

    // No rounding issues
    const totalValue = await strategy.getTotalValue()
    const strategyShareValueScaled = totalValue.mul(bn(1e36)).div(strategyShares)
    expectWithError(accountValue, strategyShares.mul(strategyShareValueScaled).div(bn(1e36)))
  })

  it('handles DAI airdrops', async () => {
    const previousValue = await vault.getAccountCurrentValue(whale.address, strategy.address)

    // Airdrop 1000 DAI and invest
    dai.connect(whale).transfer(strategy.address, fp(1000))
    await strategy.invest(dai.address)

    const currentValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expect(currentValue).to.be.gt(previousValue)
  })

  it('handles USDC airdrops', async () => {
    // Airdrop 1000 USDC
    const previousValue = await vault.getAccountCurrentValue(whale.address, strategy.address)

    // Airdrop 1000 DAI and invest
    usdc.connect(whale).transfer(strategy.address, fp(1000).div(bn(1e12)))
    await strategy.invest(usdc.address)

    const currentValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expect(currentValue).to.be.gt(previousValue)
  })

  it('exits with a 100%', async () => {
    const previousBalance = await vault.getAccountBalance(whale.address, dai.address)

    const exitRatio = fp(1)
    await vault.connect(whale).exit(whale.address, strategy.address, exitRatio, false, '0x')

    // The user should at least have some gains
    const currentBalance = await vault.getAccountBalance(whale.address, dai.address)
    const minExpectedBalance = JOIN_AMOUNT.mul(exitRatio).div(fp(1))
    expect(currentBalance.sub(previousBalance)).to.be.gt(minExpectedBalance)

    // There should not be any remaining tokens in the strategy
    const strategyDaiBalance = await dai.balanceOf(strategy.address)
    expect(strategyDaiBalance).to.be.equal(0)

    const currentInvestment = await vault.getAccountInvestment(whale.address, strategy.address)
    expectWithError(currentInvestment.invested, bn(0))
    expectWithError(currentInvestment.shares, bn(0))

    const strategyShares = await vault.getStrategyShares(strategy.address)
    expectWithError(strategyShares, bn(0))

    const accountValue = await vault.getAccountCurrentValue(whale.address, strategy.address)
    expectWithError(accountValue, bn(0))
  })
})
