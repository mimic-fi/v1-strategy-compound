import { expect } from 'chai'
import { Contract } from 'ethers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
import { deploy, fp, bn, getSigner, impersonateWhale, instanceAt } from '@mimic-fi/v1-helpers'
import { incrementBlock } from './helpers/network'

describe('CompoundStrategy - Join', function () {
  let owner: SignerWithAddress, whale: SignerWithAddress, vault: Contract, strategy: Contract, dai: Contract, cdai: Contract, comp: Contract

  const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
  const CDAI = '0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643'
  const COMP = '0xc00e94cb662c3520282e6f5717214004a7f26888'

  const MAX_UINT_256 = bn(2).pow(256).sub(1)
  const MAX_UINT_96 = bn(2).pow(96).sub(1)

  before('load signers', async () => {
    owner = await getSigner()
    whale = await impersonateWhale(fp(100))
  })

  before('deploy vault', async () => {
    const protocolFee = fp(0.00003)
    const swapConnector = owner.address // random address
    const whitelistedStrategies: string[] = []
    vault = await deploy('Vault', [protocolFee, swapConnector, whitelistedStrategies])
  })

  before('load tokens', async () => {
    dai = await instanceAt('IERC20', DAI)
    cdai = await instanceAt('ICToken', CDAI)
    comp = await instanceAt('IERC20', COMP)
  })

  before('deposit to Vault', async () => {
    await dai.connect(whale).approve(vault.address, fp(100))
    await vault.connect(whale).deposit(whale.address, [dai.address], [fp(100)])
  })

  before('deploy strategy', async () => {
    strategy = await deploy('CompoundStrategy', [vault.address, dai.address, cdai.address, 'metadata:uri'])
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

    await vault.connect(whale).exit(whale.address, strategy.address, fp(1), '0x')

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

  it('can give allowance to other tokens', async () => {
    await strategy.approveVault(comp.address)

    //Max allowance for COMP token is uint96(-1)
    const allowance = await comp.allowance(strategy.address, vault.address)
    expect(allowance).to.be.equal(MAX_UINT_96)
  })

  it('cannot give CDAI allowance to vault ', async () => {
    await expect(strategy.approveVault(cdai.address)).to.be.revertedWith('COMPOUND_INTERNAL_TOKEN')
  })

  it('handle DAI airdrops', async () => {
    await vault.connect(whale).join(whale.address, strategy.address, fp(50), '0x')

    //airdrop 1
    dai.connect(whale).transfer(strategy.address, fp(1000))

    //total shares = cdai
    let cdaiBalance = await cdai.balanceOf(strategy.address)
    let totalShares = await strategy.getTotalShares()
    expect(totalShares).to.be.equal(cdaiBalance)

    await vault.connect(whale).exit(whale.address, strategy.address, fp(0.5), '0x')

    //dai not affected
    let currentStrategyBalance = await dai.balanceOf(strategy.address)
    expect(currentStrategyBalance).to.be.equal(fp(1000))

    await vault.connect(whale).exit(whale.address, strategy.address, fp(1), '0x')

    //invest aidrop
    await strategy.investAll()

    //total shares < cdai
    cdaiBalance = await cdai.balanceOf(strategy.address)
    totalShares = await strategy.getTotalShares()
    expect(totalShares.lt(cdaiBalance)).to.be.true

    //dai sent to whale
    currentStrategyBalance = await dai.balanceOf(strategy.address)
    expect(currentStrategyBalance).to.be.equal(0)

    //total shares = 0
    totalShares = await strategy.getTotalShares()
    expect(totalShares).to.be.equal(0)
  })
})
