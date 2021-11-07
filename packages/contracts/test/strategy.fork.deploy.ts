import { deploy, fp, getSigner, impersonate, instanceAt, ZERO_ADDRESS } from '@mimic-fi/v1-helpers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
import { expect } from 'chai'
import { Contract } from 'ethers'

describe('CompoundStrategy - Deploy', function () {
  let owner: SignerWithAddress, vault: Contract, strategy: Contract, dai: Contract, cdai: Contract, comp: Contract

  // eslint-disable-next-line no-secrets/no-secrets
  const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
  const CDAI = '0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643'
  const COMP = '0xc00e94cb662c3520282e6f5717214004a7f26888'

  before('load signers', async () => {
    owner = await getSigner()
    owner = await impersonate(owner.address, fp(100))
  })

  before('deploy vault', async () => {
    const maxSlippage = fp(0.02)
    const protocolFee = fp(0.00003)
    const priceOracle = owner.address // random address
    const swapConnector = owner.address // random address
    const whitelistedTokens: string[] = []
    const whitelistedStrategies: string[] = []

    vault = await deploy('@mimic-fi/v1-vault/artifacts/contracts/Vault.sol/Vault', [
      maxSlippage,
      protocolFee,
      priceOracle,
      swapConnector,
      whitelistedTokens,
      whitelistedStrategies,
    ])
  })

  before('load tokens', async () => {
    dai = await instanceAt('IERC20', DAI)
    cdai = await instanceAt('ICToken', CDAI)
    comp = await instanceAt('IERC20', COMP)
  })

  it('deploy strategy', async () => {
    const slippage = fp(0.01)
    strategy = await deploy('CompoundStrategy', [
      vault.address,
      dai.address,
      cdai.address,
      comp.address,
      ZERO_ADDRESS,
      slippage,
      'metadata:uri',
    ])

    expect(await strategy.getVault()).to.be.equal(vault.address)
    expect(await strategy.getToken()).to.be.equal(dai.address)
    expect(await strategy.getCToken()).to.be.equal(cdai.address)
    expect(await strategy.getMetadataURI()).to.be.equal('metadata:uri')
    expect(await strategy.getTotalShares()).to.be.equal(0)
  })
})
