import { deserialize, ObjectSchema } from 'atomicassets';

import { ContractDBTransaction } from '../../database';
import { ShipBlock } from '../../../types/ship';
import { EosioTableRow } from '../../../types/eosio';
import {
    AssetsTableRow,
    BalancesTableRow,
    CollectionsTableRow,
    ConfigTableRow,
    OffersTableRow,
    PresetsTableRow,
    SchemesTableRow,
    TokenConfigsTableRow
} from './types/tables';
import AtomicAssetsHandler, { JobPriority } from './index';
import logger from '../../../utils/winston';
import { eosioTimestampToDate, serializeEosioName } from '../../../utils/eosio';
import { saveAssetTableRow, saveOfferTableRow } from './helper';

export default class AtomicAssetsTableHandler {
    private readonly contractName: string;
    
    constructor(readonly core: AtomicAssetsHandler) { 
        this.contractName = serializeEosioName(this.core.args.atomicassets_account);
    }

    async handleUpdate(db: ContractDBTransaction, block: ShipBlock, delta: EosioTableRow): Promise<void> {
        if (typeof delta.value === 'string') {
            throw new Error('Data of atomicassets table could not be deserialized: ' + delta.table);
        }

        if (delta.code !== this.core.args.atomicassets_account) {
            logger.warn('[atomicassets] Received table delta from wrong contract: ' + delta.code);
        }

        if (delta.table === 'assets') {
            this.core.addJob(async () => {
                logger.debug('AtomicAssets Delta', delta);
                // @ts-ignore
                await this.handleAssetsUpdate(db, block, delta.scope, delta.value, !delta.present);
            }, JobPriority.TABLE_ASSETS);
        } else if (delta.table === 'balances' && delta.scope === this.core.args.atomicassets_account) {
            this.core.addJob(async () => {
                logger.debug('AtomicAssets Delta', delta);
                // @ts-ignore
                await this.handleBalancesUpdate(db, block, delta.value, !delta.present);
            }, JobPriority.TABLE_BALANCES);
        } else if (delta.table === 'collections' && delta.scope === this.core.args.atomicassets_account) {
            this.core.addJob(async () => {
                logger.debug('AtomicAssets Delta', delta);
                // @ts-ignore
                await this.handleCollectionsUpdate(db, block, delta.value, !delta.present);
            }, JobPriority.TABLE_COLLECTIONS);
        } else if (delta.table === 'offers' && delta.scope === this.core.args.atomicassets_account) {
            this.core.addJob(async () => {
                logger.debug('AtomicAssets Delta', delta);
                // @ts-ignore
                await this.handleOffersUpdate(db, block, delta.value, !delta.present);
            }, JobPriority.TABLE_OFFERS);
        } else if (delta.table === 'presets') {
            this.core.addJob(async () => {
                logger.debug('AtomicAssets Delta', delta);
                // @ts-ignore
                await this.handlePresetsUpdate(db, block, delta.scope, delta.value, !delta.present);
            }, JobPriority.TABLE_PRESETS);
        } else if (delta.table === 'schemes') {
            this.core.addJob(async () => {
                logger.debug('AtomicAssets Delta', delta);
                // @ts-ignore
                await this.handleSchemesUpdate(db, block, delta.scope, delta.value, !delta.present);
            }, JobPriority.TABLE_SCHEMES);
        } else if (delta.table === 'config' && delta.scope === this.core.args.atomicassets_account) {
            this.core.addJob(async () => {
                logger.debug('AtomicAssets Delta', delta);
                // @ts-ignore
                const data: ConfigTableRow = delta.value;

                const supportedTokensQuery = await db.query(
                    'SELECT token_symbol FROM atomicassets_token_symbols WHERE contract = $1',
                    [this.contractName]
                );

                if (supportedTokensQuery.rowCount < data.supported_tokens.length) {
                    for (const token of data.supported_tokens) {
                        await db.replace('atomicassets_token_symbols', {
                            contract: this.contractName,
                            token_symbol: serializeEosioName(token.token_symbol.split(',')[1].toLowerCase()),
                            token_contract: serializeEosioName(token.token_contract),
                            token_precision: token.token_symbol.split(',')[0]
                        }, ['contract', 'token_symbol']);
                    }
                }

                await db.update('atomicassets_config', {
                    collection_format: data.collection_format.map((element: any) => JSON.stringify(element))
                }, {
                    str: 'contract = $1',
                    values: [this.contractName]
                }, ['contract']);

                this.core.config.collection_format = ObjectSchema(data.collection_format);
            }, JobPriority.TABLE_CONFIG);
        } else if (delta.table === 'tokenconfigs' && delta.scope === this.core.args.atomicassets_account) {
            this.core.addJob(async () => {
                logger.debug('AtomicAssets Delta', delta);
                // @ts-ignore
                const data: TokenConfigsTableRow = delta.value;

                await db.update('atomicassets_config', {
                    version: data.version
                }, {
                    str: 'contract = $1',
                    values: [this.contractName]
                }, ['contract']);

                this.core.config.version = data.version;
            }, JobPriority.TABLE_TOKENCONFIGS);
        } else {
            logger.warn('[atomicassets] Received table delta from unknown table: ' + delta.table + ' - ' + delta.scope);
        }
    }

    async handleAssetsUpdate(
        db: ContractDBTransaction, block: ShipBlock, scope: string, data: AssetsTableRow, deleted: boolean
    ): Promise<void> {
        await saveAssetTableRow(db, block, this.contractName, scope, data, deleted);
    }

    async handleBalancesUpdate(
        db: ContractDBTransaction, block: ShipBlock, data: BalancesTableRow, _: boolean
    ): Promise<void> {
        const symbols = data.quantities.map((quantity) => serializeEosioName(quantity.split(' ')[1].toLowerCase()));

        await db.delete('atomicassets_balances', {
            str: 'contract = $1 AND owner = $2 AND token_symbol NOT IN (' + symbols.join(', ') + ')',
            values: [this.contractName, serializeEosioName(data.owner)]
        });

        for (const quantity of data.quantities) {
            await db.replace('atomicassets_balances', {
                contract: this.contractName,
                owner: serializeEosioName(data.owner),
                token_symbol: serializeEosioName(quantity.split(' ')[1].toLowerCase()),
                amount: quantity.split(' ')[0].replace('.', ''),
                updated_at_block: block.block_num,
                updated_at_time: eosioTimestampToDate(block.timestamp).getTime()
            }, ['contract', 'owner', 'token_symbol']);
        }
    }

    async handleCollectionsUpdate(
        db: ContractDBTransaction, block: ShipBlock, data: CollectionsTableRow, deleted: boolean
    ): Promise<void> {
        if (deleted) {
            throw new Error('A collection was deleted. Should not be possible by contract');
        }

        const deserializedData = deserialize(new Uint8Array(data.serialized_data), this.core.config.collection_format);

        await db.replace('atomicassets_collections', {
            contract: this.contractName,
            collection_name: serializeEosioName(data.collection_name),
            readable_name: deserializedData.name ? String(deserializedData.name).substr(0, 64) : null,
            author: serializeEosioName(data.author),
            allow_notify: data.allow_notify,
            authorized_accounts: data.authorized_accounts.map((account) => serializeEosioName(account)),
            notify_accounts: data.notify_accounts.map((account) => serializeEosioName(account)),
            market_fee: data.market_fee,
            data: JSON.stringify(deserializedData),
            created_at_block: block.block_num,
            created_at_time: eosioTimestampToDate(block.timestamp).getTime()
        }, ['contract', 'collection_name'], ['created_at_block', 'created_at_time']);
    }

    async handleOffersUpdate(
        db: ContractDBTransaction, block: ShipBlock, data: OffersTableRow, deleted: boolean
    ): Promise<void> {
        await saveOfferTableRow(db, block, this.contractName, data, deleted);
    }

    async handlePresetsUpdate(
        db: ContractDBTransaction, block: ShipBlock, scope: string, data: PresetsTableRow, deleted: boolean
    ): Promise<void> {
        if (deleted) {
            throw new Error('A preset was deleted. Should not be possible by contract');
        }

        const schemeQuery = await db.query(
            'SELECT format FROM atomicassets_schemes WHERE contract = $1 AND collection_name = $2 AND scheme_name = $3',
            [this.contractName, serializeEosioName(scope), serializeEosioName(data.scheme_name)]
        );

        if (schemeQuery.rowCount === 0) {
            throw new Error('Scheme of preset not found. Should not be possible by contract');
        }

        const immutableData = deserialize(new Uint8Array(data.immutable_serialized_data), ObjectSchema(schemeQuery.rows[0].format));

        await db.replace('atomicassets_presets', {
            contract: this.contractName,
            preset_id: data.preset_id,
            collection_name: serializeEosioName(scope),
            scheme_name: serializeEosioName(data.scheme_name),
            readable_name: immutableData.name ? String(immutableData.name).substr(0, 64) : null,
            transferable: data.transferable,
            burnable: data.burnable,
            max_supply: data.max_supply,
            issued_supply: data.issued_supply,
            created_at_block: block.block_num,
            created_at_time: eosioTimestampToDate(block.timestamp).getTime()
        }, ['contract', 'preset_id'], ['created_at_block', 'created_at_time']);

        await db.query(
            'DELETE FROM atomicassets_presets_data WHERE contract = $1 AND preset_id = $2',
            [this.contractName, data.preset_id]
        );

        const keys = Object.keys(immutableData);
        const values = [];

        for (const key of keys) {
            values.push({
                contract: this.contractName,
                preset_id: data.preset_id,
                key, value: JSON.stringify(immutableData[key])
            });
        }

        await db.insert('atomicassets_presets_data', values, ['contract', 'preset_id', 'key']);
    }

    async handleSchemesUpdate(
        db: ContractDBTransaction, block: ShipBlock, scope: string, data: SchemesTableRow, deleted: boolean
    ): Promise<void> {
        if (deleted) {
            throw new Error('A scheme was deleted. Should not be possible by contract');
        }

        await db.replace('atomicassets_schemes', {
            contract: this.contractName,
            collection_name: serializeEosioName(scope),
            scheme_name: serializeEosioName(data.scheme_name),
            format: data.format.map((element: any) => JSON.stringify(element)),
            created_at_block: block.block_num,
            created_at_time: eosioTimestampToDate(block.timestamp).getTime()
        }, ['contract', 'collection_name', 'scheme_name'], ['created_at_block', 'created_at_time']);
    }
}