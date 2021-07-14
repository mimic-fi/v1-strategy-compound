import { expect } from 'chai'
import { Contract } from 'ethers'
import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'
import { deploy, fp, getSigner, impersonateWhale, instanceAt } from '@mimic-fi/v1-helpers'

describe('CompoundStrategy', function () {
  let owner: SignerWithAddress, whale: SignerWithAddress, vault: Contract, strategy: Contract, dai: Contract, cdai: Contract

  const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
  const CDAI = '0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643'

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
  })

  it('deploy strategy', async () => {
    strategy = await deploy('CompoundStrategy', [vault.address, dai.address, cdai.address, 'metadata:uri'])

    expect(await strategy.vault()).to.be.equal(vault.address)
    expect(await strategy.token()).to.be.equal(dai.address)
    expect(await strategy.ctoken()).to.be.equal(cdai.address)

    expect(await strategy.getToken()).to.be.equal(dai.address)
    expect(await strategy.getMetadataURI()).to.be.equal('metadata:uri')

    expect(await strategy.getTotalShares()).to.be.equal(0)
    expect(await strategy.getTokenBalance()).to.be.equal(0)
  })
})
