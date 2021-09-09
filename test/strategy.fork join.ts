import { expect } from 'chai'
import { Contract } from 'ethers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
import { deploy, fp, bn, getSigner, impersonate, impersonateWhale, instanceAt } from '@mimic-fi/v1-helpers'
import { incrementBlock } from './helpers/network'

describe('CompoundStrategy - Join', function () {
  let owner: SignerWithAddress,
    whale: SignerWithAddress,
    whale2: SignerWithAddress,
    vault: Contract,
    strategy: Contract,
    dai: Contract,
    cdai: Contract,
    comp: Contract,
    usdc: Contract

  const WHALE_WITH_DAI_AND_WETH = '0x5E9F736f314C9108aC72D4CfEd4Bcc09c01309a6'

  const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
  const CDAI = '0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643'
  const COMP = '0xc00e94cb662c3520282e6f5717214004a7f26888'
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

  const COMPTROLLER = '0x3d9819210A31b4961b30EF54bE2aeD79B9c9Cd3B'

  const UNISWAP_V2_ROUTER_ADDRESS = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'

  const CHAINLINK_ORACLE_DAI_ETH = '0x773616E4d11A78F511299002da57A0a94577F1f4'
  const CHAINLINK_ORACLE_USDC_ETH = '0x986b5E1e1755e3C2440e960477f25201B0a8bbD4'
  const CHAINLINK_ORACLE_COMP_ETH = '0x1B39Ee86Ec5979ba5C322b826B3ECb8C79991699'

  const MAX_UINT_256 = bn(2).pow(256).sub(1)

  before('load signers', async () => {
    owner = await getSigner()
    owner = await impersonate(owner.address, fp(100))
    whale = await impersonateWhale(fp(100))
    whale2 = await impersonate(WHALE_WITH_DAI_AND_WETH, fp(100))
  })

  before('deploy vault', async () => {
    const protocolFee = fp(0.00003)
    const whitelistedTokens: string[] = []
    const whitelistedStrategies: string[] = []

    const priceOracleTokens: string[] = [DAI, USDC, COMP]
    const priceOracleFeeds: string[] = [CHAINLINK_ORACLE_DAI_ETH, CHAINLINK_ORACLE_USDC_ETH, CHAINLINK_ORACLE_COMP_ETH]

    const priceOracle = await deploy('ChainLinkPriceOracle', [priceOracleTokens, priceOracleFeeds])
    const swapConnector = await deploy('UniswapConnector', [UNISWAP_V2_ROUTER_ADDRESS])

    vault = await deploy('@mimic-fi/v1-vault/artifacts/contracts/Vault.sol/Vault', [
      protocolFee,
      priceOracle.address,
      swapConnector.address,
      whitelistedTokens,
      whitelistedStrategies,
    ])
  })

  before('load tokens', async () => {
    dai = await instanceAt('IERC20', DAI)
    cdai = await instanceAt('ICToken', CDAI)
    comp = await instanceAt('IERC20', COMP)
    usdc = await instanceAt('IERC20', USDC)
  })

  before('deposit to Vault', async () => {
    await dai.connect(whale).approve(vault.address, fp(100))
    await vault.connect(whale).deposit(whale.address, dai.address, fp(100))
  })

  before('deploy strategy', async () => {
    const slippage = fp(0.01)
    strategy = await deploy('CompoundStrategy', [
      vault.address,
      dai.address,
      cdai.address,
      comp.address,
      COMPTROLLER,
      slippage,
      'metadata:uri',
    ])
  })

  it('vault has max DAI allowance', async () => {
    const allowance = await dai.allowance(strategy.address, vault.address)
    expect(allowance).to.be.equal(MAX_UINT_256)
  })

  it('join strategy', async () => {
    const amount = fp(50)

    const previousVaultBalance = await dai.balanceOf(vault.address)

    const previousStrategyBalance = await dai.balanceOf(strategy.address)
    expect(previousStrategyBalance).to.be.equal(0)

    await vault.connect(whale).join(whale.address, strategy.address, amount, '0x')

    const currentVaultBalance = await dai.balanceOf(vault.address)
    expect(currentVaultBalance).to.be.equal(previousVaultBalance.sub(amount))

    const currentStrategyBalance = await dai.balanceOf(strategy.address)
    expect(currentStrategyBalance).to.be.equal(previousStrategyBalance)

    const currentInvestment = await vault.getAccountInvestment(whale.address, strategy.address)
    expect(currentInvestment[0]).to.be.equal(amount)
    expect(currentInvestment[1].gt(0)).to.be.true

    const cdaiBalance = await cdai.balanceOf(strategy.address)
    const totalShares = await strategy.getTotalShares()
    expect(totalShares).to.be.equal(cdaiBalance)
  })

  it('has strategy gains', async () => {
    const initialBalance = await strategy.getTokenBalance()

    //Increments blocks
    await incrementBlock(400)
    //Force update of rate
    await cdai.connect(whale).exchangeRateCurrent()

    const finalBalance = await strategy.getTokenBalance()
    expect(finalBalance.gt(initialBalance)).to.be.true
  })

  it('exit strategy', async () => {
    const initialAmount = fp(50)
    const initialBalance = await vault.getAccountBalance(whale.address, dai.address)

    await vault.connect(whale).exit(whale.address, strategy.address, fp(1), false, '0x')

    const currentBalance = await vault.getAccountBalance(whale.address, dai.address)
    const finalAmount = currentBalance.sub(initialBalance)

    expect(finalAmount.gt(initialAmount)).to.be.true

    const currentStrategyBalance = await dai.balanceOf(strategy.address)
    expect(currentStrategyBalance).to.be.equal(0)

    const currentInvestment = await vault.getAccountInvestment(whale.address, strategy.address)

    expect(currentInvestment[0]).to.be.equal(0)
    expect(currentInvestment[1]).to.be.equal(0)

    const cdaiBalance = await cdai.balanceOf(strategy.address)
    expect(cdaiBalance).to.be.equal(0)

    const totalShares = await strategy.getTotalShares()
    expect(totalShares).to.be.equal(0)
  })

  it('can give token allowance to vault and ctoken', async () => {
    await strategy.approveTokenSpenders()

    const vaultAllowance = await dai.allowance(strategy.address, vault.address)
    expect(vaultAllowance).to.be.equal(MAX_UINT_256)

    const cdaiAllowance = await dai.allowance(strategy.address, cdai.address)
    expect(cdaiAllowance).to.be.equal(MAX_UINT_256)
  })

  it('handle DAI airdrops', async () => {
    //airdrop 1000
    dai.connect(whale).transfer(strategy.address, fp(1000))

    //total shares = cdai
    const initialCdaiBalance = await cdai.balanceOf(strategy.address)
    const initialShares = await strategy.getTotalShares()

    expect(initialShares).to.be.equal(initialCdaiBalance)

    //invest aidrop
    await strategy.invest(dai.address)

    //total shares < bpt
    const finalCdaiBalance = await cdai.balanceOf(strategy.address)
    const finalShares = await strategy.getTotalShares()

    expect(initialCdaiBalance.lt(finalCdaiBalance)).to.be.true
    expect(initialShares).to.be.equal(finalShares)
  })

  it('handle USDC airdrops', async () => {
    //airdrop 1000
    usdc.connect(whale).transfer(strategy.address, fp(1000).div(bn('1e12')))

    const daiBalance = await dai.balanceOf(strategy.address)
    expect(daiBalance).to.be.equal(0)

    const initialCdaiBalance = await cdai.balanceOf(strategy.address)
    const initialShares = await strategy.getTotalShares()

    //invest aidrop
    await strategy.invest(usdc.address)

    const finalCdaiBalance = await cdai.balanceOf(strategy.address)
    const finalShares = await strategy.getTotalShares()

    expect(initialCdaiBalance.lt(finalCdaiBalance)).to.be.true
    expect(initialShares).to.be.equal(finalShares)
  })

  it('handle DAI airdrops + Join', async () => {
    const joinAmount = fp(50)

    //Make it so there are some previous shares
    const depositAmount = joinAmount.mul(2)
    await dai.connect(whale2).approve(vault.address, depositAmount)
    await vault.connect(whale2).deposit(whale2.address, dai.address, depositAmount)
    await vault.connect(whale2).join(whale2.address, strategy.address, joinAmount, '0x')

    const initialShares = await strategy.getTotalShares()

    //All dai invested
    const daiBalance = await dai.balanceOf(strategy.address)
    expect(daiBalance).to.be.equal(0)

    //airdrop 1000
    const aidrop = fp(100000)
    await dai.connect(whale).transfer(strategy.address, aidrop)

    //whale joins
    await vault.connect(whale).join(whale.address, strategy.address, joinAmount, '0x')

    //Final token balance includes 100k airdrop + joinAmount
    const finalShares = await strategy.getTotalShares()

    //shares obtained by the whale should be close to how much dai it adds and not the airdropped one
    expect(
      finalShares
        .sub(initialShares)
        .mul(fp(1))
        .div(initialShares)
        .lte(joinAmount.mul(fp(1)).div(joinAmount.add(aidrop)))
    ).to.be.true
  })
})
