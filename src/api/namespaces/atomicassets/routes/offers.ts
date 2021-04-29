import * as express from 'express';

import { AtomicAssetsNamespace } from '../index';
import { HTTPServer } from '../../../server';
import logger from '../../../../utils/winston';
import { buildBoundaryFilter, filterQueryArgs } from '../../utils';
import { FillerHook, fillOffers } from '../filler';
import { actionGreylistParameters, getOpenAPI3Responses, paginationParameters } from '../../../docs';
import { OfferState } from '../../../../filler/handlers/atomicassets';
import { greylistFilterParameters } from '../openapi';
import {
    applyActionGreylistFilters,
    createSocketApiNamespace,
    extractNotificationIdentifiers,
    getContractActionLogs
} from '../../../utils';
import ApiNotificationReceiver from '../../../notification';
import { NotificationData } from '../../../../filler/notifier';

export class OfferApi {
    constructor(
        readonly core: AtomicAssetsNamespace,
        readonly server: HTTPServer,
        readonly schema: string,
        readonly offerView: string,
        readonly offerFormatter: (_: any) => any,
        readonly assetView: string,
        readonly assetFormatter: (_: any) => any,
        readonly fillerHook?: FillerHook
    ) { }

    endpoints(router: express.Router): any {
        router.all(['/v1/offers', '/v1/offers/_count'], this.server.web.caching(), (async (req, res) => {
            try {
                const args = filterQueryArgs(req, {
                    page: {type: 'int', min: 1, default: 1},
                    limit: {type: 'int', min: 1, max: 100, default: 100},
                    sort: {type: 'string', values: ['created', 'updated'], default: 'created'},
                    order: {type: 'string', values: ['asc', 'desc'], default: 'desc'},

                    account: {type: 'string', min: 1},
                    sender: {type: 'string', min: 1},
                    recipient: {type: 'string', min: 1},
                    state: {type: 'string', min: 1},

                    asset_id: {type: 'string', min: 1},
                    collection_name: {type: 'string', min: 1},
                    template_id: {type: 'string', min: 1},
                    schema_name: {type: 'string', min: 1},

                    recipient_asset_blacklist: {type: 'string', min: 1},
                    recipient_asset_whitelist: {type: 'string', min: 1},
                    sender_asset_blacklist: {type: 'string', min: 1},
                    sender_asset_whitelist: {type: 'string', min: 1},
                    account_whitelist: {type: 'string', min: 1},
                    account_blacklist: {type: 'string', min: 1},
                    collection_blacklist: {type: 'string', min: 1},
                    collection_whitelist: {type: 'string', min: 1},

                    is_recipient_contract: {type: 'bool'}
                });

                let varCounter = 1;
                let queryString = 'SELECT contract, offer_id FROM atomicassets_offers offer WHERE contract = $1 ';

                const queryValues: any[] = [this.core.args.atomicassets_account];

                if (args.account) {
                    queryString += 'AND (sender = ANY ($' + ++varCounter + ') OR recipient = ANY ($' + varCounter + ')) ';
                    queryValues.push(args.account.split(','));
                }

                if (args.sender) {
                    queryString += 'AND sender = ANY ($' + ++varCounter + ') ';
                    queryValues.push(args.sender.split(','));
                }

                if (args.recipient) {
                    queryString += 'AND recipient = ANY ($' + ++varCounter + ') ';
                    queryValues.push(args.recipient.split(','));
                }

                if (args.state) {
                    queryString += 'AND state = ANY ($' + ++varCounter + ') ';
                    queryValues.push(args.state.split(','));
                }

                if (args.is_recipient_contract === true) {
                    queryString += 'AND EXISTS(SELECT * FROM contract_codes WHERE account = offer.recipient) ';
                } else if (args.is_recipient_contract === false) {
                    queryString += 'AND NOT EXISTS(SELECT * FROM contract_codes WHERE account = offer.recipient) ';
                }

                if (['collection_name', 'template_id', 'schema_name'].find(key => args[key])) {
                    const conditions: string[] = [];

                    if (args.asset_id) {
                        conditions.push('offer_asset.asset_id = ANY ($' + ++varCounter + ')');
                        queryValues.push(args.asset_id.split(','));
                    }

                    if (args.collection_name) {
                        conditions.push('asset.collection_name = ANY ($' + ++varCounter + ')');
                        queryValues.push(args.collection_name.split(','));
                    }

                    if (args.template_id) {
                        conditions.push('asset.template_id = ANY ($' + ++varCounter + ')');
                        queryValues.push(args.template_id.split(','));
                    }

                    if (args.schema_name) {
                        conditions.push('asset.schema_name = ANY ($' + ++varCounter + ')');
                        queryValues.push(args.schema_name.split(','));
                    }

                    queryString += 'AND EXISTS(' +
                        'SELECT * FROM atomicassets_offers_assets offer_asset, atomicassets_assets asset ' +
                        'WHERE offer_asset.contract = offer.contract AND offer_asset.offer_id = offer.offer_id AND ' +
                        'offer_asset.contract = asset.contract AND offer_asset.asset_id = asset.asset_id AND (' + conditions.join(' OR ') + ')) ';
                }

                if (args.asset_id) {
                    queryString += 'AND EXISTS(' +
                        'SELECT * FROM atomicassets_offers_assets asset ' +
                        'WHERE offer.contract = asset.contract AND offer.offer_id = asset.offer_id AND ' +
                        'asset_id = ANY ($' + ++varCounter + ')' +
                        ') ';
                    queryValues.push(args.asset_id.split(','));
                }

                if (args.collection_blacklist) {
                    queryString += 'AND NOT EXISTS(' +
                        'SELECT * FROM atomicassets_offers_assets offer_asset, atomicassets_assets asset ' +
                        'WHERE offer_asset.contract = offer.contract AND offer_asset.offer_id = offer.offer_id AND ' +
                        'offer_asset.contract = asset.contract AND offer_asset.asset_id = asset.asset_id AND ' +
                        'asset.collection_name = ANY ($' + ++varCounter + ')' +
                        ') ';
                    queryValues.push(args.collection_blacklist.split(','));
                }

                if (args.collection_whitelist) {
                    queryString += 'AND NOT EXISTS(' +
                        'SELECT * FROM atomicassets_offers_assets offer_asset, atomicassets_assets asset ' +
                        'WHERE offer_asset.contract = offer.contract AND offer_asset.offer_id = offer.offer_id AND ' +
                        'offer_asset.contract = asset.contract AND offer_asset.asset_id = asset.asset_id AND ' +
                        'NOT (asset.collection_name = ANY ($' + ++varCounter + '))' +
                        ') ';
                    queryValues.push(args.collection_whitelist.split(','));
                }

                if (args.account_blacklist) {
                    const varNumber = ++varCounter;
                    queryString += 'AND NOT (offer.sender = ANY($' + varNumber + ') OR offer.recipient = ANY($' + varNumber + ')) ';
                    queryValues.push(args.account_blacklist.split(','));
                }

                if (args.account_whitelist) {
                    const varNumber = ++varCounter;
                    queryString += 'AND (offer.sender = ANY($' + varNumber + ') OR offer.recipient = ANY($' + varNumber + ')) ';
                    queryValues.push(args.account_whitelist.split(','));
                }

                if (args.recipient_asset_blacklist) {
                    queryString += 'AND NOT EXISTS(' +
                        'SELECT * FROM atomicassets_offers_assets offer_asset ' +
                        'WHERE offer_asset.contract = offer.contract AND offer_asset.offer_id = offer.offer_id AND ' +
                        'offer_asset.owner = offer.recipient AND offer_asset.asset_id = ANY ($' + ++varCounter + ')' +
                        ') ';
                    queryValues.push(args.recipient_asset_blacklist.split(','));
                }

                if (args.recipient_asset_whitelist) {
                    queryString += 'AND NOT EXISTS(' +
                        'SELECT * FROM atomicassets_offers_assets offer_asset ' +
                        'WHERE offer_asset.contract = offer.contract AND offer_asset.offer_id = offer.offer_id AND ' +
                        'offer_asset.owner = offer.recipient AND NOT (offer_asset.asset_id = ANY ($' + ++varCounter + '))' +
                        ') ';
                    queryValues.push(args.recipient_asset_whitelist.split(','));
                }

                if (args.sender_asset_blacklist) {
                    queryString += 'AND NOT EXISTS(' +
                        'SELECT * FROM atomicassets_offers_assets offer_asset ' +
                        'WHERE offer_asset.contract = offer.contract AND offer_asset.offer_id = offer.offer_id AND ' +
                        'offer_asset.owner = offer.sender AND offer_asset.asset_id = ANY ($' + ++varCounter + ')' +
                        ') ';
                    queryValues.push(args.sender_asset_blacklist.split(','));
                }

                if (args.sender_asset_whitelist) {
                    queryString += 'AND NOT EXISTS(' +
                        'SELECT * FROM atomicassets_offers_assets offer_asset ' +
                        'WHERE offer_asset.contract = offer.contract AND offer_asset.offer_id = offer.offer_id AND ' +
                        'offer_asset.owner = offer.sender AND NOT (offer_asset.asset_id = ANY ($' + ++varCounter + '))' +
                        ') ';
                    queryValues.push(args.sender_asset_whitelist.split(','));
                }

                const boundaryFilter = buildBoundaryFilter(
                    req, varCounter, 'offer_id', 'int',
                    args.sort === 'updated' ? 'updated_at_time' : 'created_at_time'
                );
                queryValues.push(...boundaryFilter.values);
                varCounter += boundaryFilter.values.length;
                queryString += boundaryFilter.str;

                const sortColumnMapping = {
                    created: 'created_at_time',
                    updated: 'updated_at_time'
                };

                if (req.originalUrl.search('/_count') >= 0) {
                    const countQuery = await this.server.query(
                        'SELECT COUNT(*) counter FROM (' + queryString + ') x',
                        queryValues
                    );

                    return res.json({success: true, data: countQuery.rows[0].counter, query_time: Date.now()});
                }

                // @ts-ignore
                queryString += 'ORDER BY ' + sortColumnMapping[args.sort] + ' ' + args.order + ', offer_id ASC ';
                queryString += 'LIMIT $' + ++varCounter + ' OFFSET $' + ++varCounter + ' ';
                queryValues.push(args.limit);
                queryValues.push((args.page - 1) * args.limit);

                const offerQuery = await this.server.query(queryString, queryValues);

                const offerLookup: {[key: string]: any} = {};
                const query = await this.server.query(
                    'SELECT * FROM ' + this.offerView + ' WHERE contract = $1 AND offer_id = ANY ($2)',
                    [this.core.args.atomicassets_account, offerQuery.rows.map(row => row.offer_id)]
                );

                query.rows.reduce((prev, current) => {
                    prev[String(current.offer_id)] = current;

                    return prev;
                }, offerLookup);

                const offers = await fillOffers(
                    this.server, this.core.args.atomicassets_account,
                    offerQuery.rows.map((row) => this.offerFormatter(offerLookup[row.offer_id])),
                    this.assetFormatter, this.assetView, this.fillerHook
                );

                return res.json({success: true, data: offers, query_time: Date.now()});
            } catch (e) {
                res.status(500).json({success: false, message: 'Internal Server Error'});
            }
        }));

        router.all('/v1/offers/:offer_id', this.server.web.caching({ignoreQueryString: true}), (async (req, res) => {
            try {
                const query = await this.server.query(
                    'SELECT * FROM atomicassets_offers_master WHERE contract = $1 AND offer_id = $2',
                    [this.core.args.atomicassets_account, req.params.offer_id]
                );

                if (query.rowCount === 0) {
                    return res.status(416).json({success: false, message: 'Offer not found'});
                }

                const offers = await fillOffers(
                    this.server, this.core.args.atomicassets_account,
                    query.rows.map((row) => this.offerFormatter(row)),
                    this.assetFormatter, this.assetView, this.fillerHook
                );

                return res.json({success: true, data: offers[0], query_time: Date.now()});
            } catch (e) {
                return res.status(500).json({success: false, message: 'Internal Server Error'});
            }
        }));

        router.all('/v1/offers/:offer_id/logs', this.server.web.caching(), (async (req, res) => {
            const args = filterQueryArgs(req, {
                page: {type: 'int', min: 1, default: 1},
                limit: {type: 'int', min: 1, max: 100, default: 100},
                order: {type: 'string', values: ['asc', 'desc'], default: 'asc'}
            });

            try {
                res.json({
                    success: true,
                    data: await getContractActionLogs(
                        this.server, this.core.args.atomicassets_account,
                        applyActionGreylistFilters(['lognewoffer', 'acceptoffer', 'declineoffer', 'canceloffer'], args),
                        {offer_id: req.params.offer_id},
                        (args.page - 1) * args.limit, args.limit, args.order
                    ), query_time: Date.now()
                });
            } catch (e) {
                logger.error(e);

                return res.status(500).json({success: false, message: 'Internal Server Error'});
            }
        }));

        return {
            tag: {
                name: 'offers',
                description: 'Offers'
            },
            paths: {
                '/v1/offers': {
                    get: {
                        tags: ['offers'],
                        summary: 'Fetch offers',
                        parameters: [
                            {
                                name: 'account',
                                in: 'query',
                                description: 'Notified account (can be sender or recipient) - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'sender',
                                in: 'query',
                                description: 'Offer sender - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'recipient',
                                in: 'query',
                                description: 'Offer recipient - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'state',
                                in: 'query',
                                description: 'Filter by Offer State (' +
                                    OfferState.PENDING.valueOf() + ': PENDING - Offer created and valid, ' +
                                    OfferState.INVALID.valueOf() + ': INVALID - Assets are missing because ownership has changed, ' +
                                    OfferState.UNKNOWN.valueOf() + ': UNKNOWN - Offer is not valid anymore, ' +
                                    OfferState.ACCEPTED.valueOf() + ': ACCEPTED - Offer was accepted, ' +
                                    OfferState.DECLINED.valueOf() + ': DECLINED - Offer was declined by recipient, ' +
                                    OfferState.CANCELLED.valueOf() + ': CANCELLED - Offer was canceled by sender' +
                                    ') - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'is_recipient_contract',
                                in: 'query',
                                description: 'Filter offers where recipient is a contract',
                                required: false,
                                schema: {type: 'boolean'}
                            },
                            {
                                name: 'asset_id',
                                in: 'query',
                                description: 'only offers which contain this asset_id - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'template_id',
                                in: 'query',
                                description: 'only offers which contain assets of this template - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'schema_name',
                                in: 'query',
                                description: 'only offers which contain assets of this schema - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'collection_name',
                                in: 'query',
                                description: 'only offers which contain assets of this collection - separate multiple with ","',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'account_whitelist',
                                in: 'query',
                                description: 'Only offers which are sent by one of these accounts',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'account_blacklist',
                                in: 'query',
                                description: 'Exclude offers which are sent by one of these accounts',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'sender_asset_whitelist',
                                in: 'query',
                                description: 'Only offers which contain these assets',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'sender_asset_blacklist',
                                in: 'query',
                                description: 'Exclude offers which contain these assets',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'recipient_asset_whitelist',
                                in: 'query',
                                description: 'Only offers which contain these assets',
                                required: false,
                                schema: {type: 'string'}
                            },
                            {
                                name: 'recipient_asset_blacklist',
                                in: 'query',
                                description: 'Exclude offers which contain these assets',
                                required: false,
                                schema: {type: 'string'}
                            },
                            ...greylistFilterParameters,
                            ...paginationParameters,
                            {
                                name: 'sort',
                                in: 'query',
                                description: 'Column to sort',
                                required: false,
                                schema: {
                                    type: 'string',
                                    enum: ['created', 'updated'],
                                    default: 'created'
                                }
                            }
                        ],
                        responses: getOpenAPI3Responses([200, 500], {type: 'array', items: {'$ref': '#/components/schemas/' + this.schema}})
                    }
                },
                '/v1/offers/{offer_id}': {
                    get: {
                        tags: ['offers'],
                        summary: 'Find offer by id',
                        parameters: [
                            {
                                name: 'offer_id',
                                in: 'path',
                                description: 'ID of offer',
                                required: true,
                                schema: {type: 'integer'}
                            }
                        ],
                        responses: getOpenAPI3Responses([200, 416, 500], {'$ref': '#/components/schemas/' + this.schema})
                    }
                },
                '/v1/offers/{offer_id}/logs': {
                    get: {
                        tags: ['offers'],
                        summary: 'Fetch offer logs',
                        parameters: [
                            {
                                name: 'offer_id',
                                in: 'path',
                                description: 'ID of offer',
                                required: true,
                                schema: {type: 'integer'}
                            },
                            ...paginationParameters,
                            ...actionGreylistParameters
                        ],
                        responses: getOpenAPI3Responses([200, 500], {type: 'array', items: {'$ref': '#/components/schemas/Log'}})
                    }
                }
            }
        };
    }

    sockets(notification: ApiNotificationReceiver): void {
        const namespace = createSocketApiNamespace(this.server, this.core.path + '/v1/offers');

        notification.onData('offers', async (notifications: NotificationData[]) => {
            const offerIDs = extractNotificationIdentifiers(notifications, 'offer_id');
            const query = await this.server.query(
                'SELECT * FROM ' + this.offerView + ' WHERE contract = $1 AND offer_id = ANY($2)',
                [this.core.args.atomicassets_account, offerIDs]
            );

            const offers = await fillOffers(
                this.server, this.core.args.atomicassets_account,
                query.rows.map((row) => this.offerFormatter(row)),
                this.assetFormatter, this.assetView, this.fillerHook
            );

            for (const notification of notifications) {
                if (notification.type === 'trace' && notification.data.trace) {
                    const trace = notification.data.trace;

                    if (trace.act.account !== this.core.args.atomicassets_account) {
                        continue;
                    }

                    const offerID = (<any>trace.act.data).offer_id;

                    if (trace.act.name === 'lognewoffer') {
                        namespace.emit('create', {
                            transaction: notification.data.tx,
                            block: notification.data.block,
                            trace: trace,
                            offer_id: offerID,
                            offer: offers.find(row => String(row.offer_id) === String(offerID)),
                        });
                    }
                } else if (notification.type === 'fork') {
                    namespace.emit('fork', {block_num: notification.data.block.block_num});
                }
            }
        });
    }
}
