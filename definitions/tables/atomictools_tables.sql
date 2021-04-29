CREATE TABLE atomictools_config (
    tools_contract character varying(12) NOT NULL,
    version character varying(64) NOT NULL,
    assets_contract character varying(12) NOT NULL,
    CONSTRAINT atomictools_config_pkey PRIMARY KEY (tools_contract)
);

CREATE TABLE atomictools_links (
    tools_contract character varying(12) NOT NULL,
    link_id bigint NOT NULL,
    assets_contract character varying(12) NOT NULL,
    creator character varying(64) NOT NULL,
    claimer character varying(64),
    state integer NOT NULL,
    key_type integer NOT NULL,
    key_data bytea NOT NULL,
    memo character varying(256) NOT NULL,
    created_at_block bigint NOT NULL,
    created_at_time bigint NOT NULL,
    updated_at_block bigint NOT NULL,
    updated_at_time bigint NOT NULL,
    CONSTRAINT atomictools_links_pkey PRIMARY KEY (tools_contract, link_id)
);

CREATE TABLE atomictools_links_assets (
    tools_contract character varying(12) NOT NULL,
    link_id bigint NOT NULL,
    assets_contract character varying(12) NOT NULL,
    "index" integer,
    asset_id bigint NOT NULL,
    CONSTRAINT atomictools_links_assets_pkey PRIMARY KEY (tools_contract, link_id, assets_contract, asset_id)
);

ALTER TABLE ONLY atomictools_links_assets
    ADD CONSTRAINT atomictools_links_assets_link_id_fkey FOREIGN KEY (tools_contract, link_id)
    REFERENCES atomictools_links (tools_contract, link_id) MATCH SIMPLE ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED NOT VALID;

CREATE INDEX atomictools_links_state ON atomictools_links USING hash (state);
CREATE INDEX atomictools_links_creator ON atomictools_links USING hash (creator);
CREATE INDEX atomictools_links_key_type ON atomictools_links USING hash (key_type);
CREATE INDEX atomictools_links_key_data ON atomictools_links USING hash (key_data);
CREATE INDEX atomictools_links_created_at_time ON atomictools_links USING btree (created_at_time);
CREATE INDEX atomictools_links_updated_at_time ON atomictools_links USING btree (updated_at_time);

CREATE INDEX atomictools_links_assets_asset_id ON atomictools_links_assets USING btree (asset_id);
