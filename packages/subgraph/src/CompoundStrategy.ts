import { Address, BigInt, ethereum, log } from '@graphprotocol/graph-ts'

import { StrategyCreated } from '../types/CompoundStrategyFactory/CompoundStrategyFactory'
import { ERC20 as ERC20Contract } from '../types/templates/CompoundStrategy/ERC20'
import { CToken as CTokenContract } from '../types/templates/CompoundStrategy/CToken'
import { CompoundStrategy as StrategyTemplate } from '../types/templates'
import { CompoundStrategy as StrategyContract } from '../types/CompoundStrategyFactory/CompoundStrategy'
import { CompoundStrategyFactory as FactoryContract } from '../types/CompoundStrategyFactory/CompoundStrategyFactory'
import { Factory as FactoryEntity, Strategy as StrategyEntity, Rate as RateEntity } from '../types/schema'

let FACTORY_ID = 'COMPOUND'
let ONE = BigInt.fromString('1000000000000000000')

export function handleStrategyCreated(event: StrategyCreated): void {
  let factory = loadOrCreateFactory(event.address)

  let strategies = factory.strategies
  strategies.push(event.params.strategy.toHexString())
  factory.strategies = strategies
  factory.save()

  StrategyTemplate.create(event.params.strategy)
}

export function handleBlock(block: ethereum.Block): void {
  let factory = FactoryEntity.load(FACTORY_ID)
  if (factory !== null && factory.strategies !== null) {
    let strategies = factory.strategies
    for (let i: i32 = 0; i < strategies.length; i++) {
      let strategy = loadOrCreateStrategy(strategies[i], factory.id, factory.address)
      if (strategy !== null) createLastRate(strategy!, block)
    }
  }
}

function loadOrCreateFactory(factoryAddress: Address): FactoryEntity {
  let factory = FactoryEntity.load(FACTORY_ID)

  if (factory === null) {
    factory = new FactoryEntity(FACTORY_ID)
    factory.strategies = []
    factory.address = factoryAddress.toHexString()
    factory.save()
  }

  return factory!
}

function loadOrCreateStrategy(strategyAddress: string, factoryId: string, factoryAddress: string): StrategyEntity {
  let strategy = StrategyEntity.load(strategyAddress)

  if (strategy === null) {
    strategy = new StrategyEntity(strategyAddress)
    strategy.factory = factoryId
    strategy.vault = getFactoryVault(factoryAddress).toHexString()
    strategy.token = getStrategyToken(strategyAddress).toHexString()
    strategy.metadata = getStrategyMetadata(strategyAddress)
    strategy.deposited = BigInt.fromI32(0)
    strategy.shares = BigInt.fromI32(0)
    strategy.save()
  }

  return strategy!
}

function createLastRate(strategy: StrategyEntity, block: ethereum.Block): void {
  let currentRate = calculateRate(strategy)

  if (strategy.lastRate === null) {
    storeLastRate(strategy, currentRate, BigInt.fromI32(0), block)
  } else {
    let lastRate = RateEntity.load(strategy.lastRate)!
    if (lastRate.value.notEqual(currentRate)) {
      let elapsed = block.number.minus(lastRate.block)
      let accumulators = lastRate.accumulators
      let accumulated = accumulators[0].plus(lastRate.value.times(elapsed))
      storeLastRate(strategy, currentRate, accumulated, block)
    }
  }
}

function storeLastRate(strategy: StrategyEntity, currentRate: BigInt, accumulated: BigInt, block: ethereum.Block): void {
  let shares = getStrategyShares(strategy.id)
  let rateId = strategy.id + '-' + block.timestamp.toString()
  let rate = new RateEntity(rateId)
  rate.value = currentRate
  rate.accumulators = []
  rate.shares = shares
  rate.strategy = strategy.id
  rate.timestamp = block.timestamp
  rate.block = block.number
  rate.save()

  let accumulators = rate.accumulators
  accumulators.push(accumulated)
  rate.accumulators = accumulators
  rate.save()

  strategy.lastRate = rateId
  strategy.deposited = shares.isZero() ? BigInt.fromI32(0) : shares.times(currentRate).div(ONE)
  strategy.save()
}

function calculateRate(strategy: StrategyEntity): BigInt {
  let totalShares = getStrategyShares(strategy.id)
  if (totalShares.equals(BigInt.fromI32(0))) {
    return BigInt.fromI32(0)
  }

  let strategyAddress = Address.fromString(strategy.id)
  let cTokenAddress = getStrategyCToken(strategyAddress)
  let cTokenBalance = getTokenBalance(cTokenAddress, strategyAddress)
  let exchangeRate = getCTokenExchangeRate(cTokenAddress)
  return cTokenBalance.times(exchangeRate).div(totalShares)
}

function getFactoryVault(address: string): Address {
  let factoryContract = FactoryContract.bind(Address.fromString(address))
  let vaultCall = factoryContract.try_vault()

  if (!vaultCall.reverted) {
    return vaultCall.value
  }

  log.warning('vault() call reverted for {}', [address])
  return Address.fromString('0x0000000000000000000000000000000000000000')
}

function getStrategyShares(address: string): BigInt {
  let strategyContract = StrategyContract.bind(Address.fromString(address))
  let sharesCall = strategyContract.try_getTotalShares()

  if (!sharesCall.reverted) {
    return sharesCall.value
  }

  log.warning('getTotalShares() call reverted for {}', [address])
  return BigInt.fromI32(0)
}

function getStrategyToken(address: string): Address {
  let strategyContract = StrategyContract.bind(Address.fromString(address))
  let tokenCall = strategyContract.try_getToken()

  if (!tokenCall.reverted) {
    return tokenCall.value
  }

  log.warning('getToken() call reverted for {}', [address])
  return Address.fromString('0x0000000000000000000000000000000000000000')
}

function getStrategyMetadata(address: string): string {
  let strategyContract = StrategyContract.bind(Address.fromString(address))
  let metadataCall = strategyContract.try_getMetadataURI()

  if (!metadataCall.reverted) {
    return metadataCall.value
  }

  log.warning('getMetadataURI() call reverted for {}', [address])
  return 'Unknown'
}

function getStrategyCToken(address: Address): Address {
  let strategyContract = StrategyContract.bind(address)
  let cTokenCall = strategyContract.try_getCToken()

  if (!cTokenCall.reverted) {
    return cTokenCall.value
  }

  log.warning('getCToken() call reverted for {}', [address.toHexString()])
  return Address.fromString('0x0000000000000000000000000000000000000000')
}

function getTokenBalance(address: Address, account: Address): BigInt {
  let tokenContract = ERC20Contract.bind(address)
  let balanceCall = tokenContract.try_balanceOf(account)

  if (!balanceCall.reverted) {
    return balanceCall.value
  }

  log.warning('balanceOf() call reverted for {}', [address.toHexString()])
  return BigInt.fromI32(0)
}

function getCTokenExchangeRate(address: Address): BigInt {
  let cTokenContract = CTokenContract.bind(address)
  let rateCall = cTokenContract.try_exchangeRateStored()

  if (!rateCall.reverted) {
    return rateCall.value
  }

  log.warning('exchangeRateStored() call reverted for {}', [address.toHexString()])
  return BigInt.fromI32(0)
}
