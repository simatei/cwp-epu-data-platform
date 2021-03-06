import * as pako from 'pako';
import * as localforage from 'localforage';
import * as geobuf from 'geobuf';
import * as Pbf from 'pbf';
import retryableFetch from './helpers/retryableFetch';
localforage.config({});

// Update this if we ever want to bust everyone's cache
const CACHE_TOKEN = 'a';

const ACCESS_TOKEN = process.env.REDIVIS_API_TOKEN;
const MAX_RESULTS = 10000;
export default class VectorSource {
	constructor({
		name,
		label,
		hierarchyIndex,
		tableIdentifier,
		geoVariables,
		isGeobuf,
		getGeometry,
		isDefault,
		showOnHome,
		filterVariables = [],
		metadataVariables = [],
		legendVariable,
		legend,
		regionNameVariable,
		regionParentVariable,
		regionBoundingBoxVariable,
		mapboxSourceType,
		mapboxLayerType,
		mapboxLayerOptions,
		minZoom,
		maxZoom,
	}) {
		this.name = name;
		this.label = label;
		this.hierarchyIndex = hierarchyIndex;
		this.tableIdentifier = tableIdentifier;
		this.geoVariables = geoVariables;
		this.isGeobuf = isGeobuf;
		this.filterVariables = filterVariables;
		this.metadataVariables = metadataVariables;
		this.legendVariable = legendVariable;
		this.legend = legend;
		this.regionNameVariable = regionNameVariable;
		this.regionParentVariable = regionParentVariable;
		this.regionBoundingBoxVariable = regionBoundingBoxVariable;
		this.mapboxSourceType = mapboxSourceType;
		this.mapboxLayerType = mapboxLayerType;
		this.mapboxLayerOptions = mapboxLayerOptions;
		this.minZoom = minZoom;
		this.maxZoom = maxZoom;
		this.isDefault = isDefault;
		this.showOnHome = showOnHome;
		this.getGeometry = getGeometry;

		this.metadata = null;
		this.data = null;
	}

	fetchMetadata = async () => {
		if (this.metadata) {
			return this.metadata;
		}
		const variablesSet = new Set([
			...this.filterVariables.map(({ name }) => name.toLowerCase()),
			...this.metadataVariables.map(({ name }) => name.toLowerCase()),
		]);

		if (this.regionNameVariable) {
			variablesSet.add(this.regionNameVariable.name.toLowerCase());
		}
		if (this.regionParentVariable) {
			variablesSet.add(this.regionParentVariable.name.toLowerCase());
		}
		if (this.regionBoundingBoxVariable) {
			variablesSet.add(this.regionBoundingBoxVariable.name.toLowerCase());
		}
		const variablesToFetch = [...variablesSet];
		const variableToFetchedIndexMap = new Map();

		for (let i = 0; i < variablesToFetch.length; i++) {
			variableToFetchedIndexMap.set(variablesToFetch[i], i);
		}

		const apiEndpoint = `https://redivis.com/api/v1/tables/${
			this.tableIdentifier
		}/rows?selectedVariables=${variablesToFetch.join(',')}&maxResults=${MAX_RESULTS}`;

		const metadata = await this.#fetchFromApi(apiEndpoint);
		try {
			this.metadata = metadata.map((row) => {
				const metadata = {};
				const properties = {};
				for (const variable of this.metadataVariables) {
					metadata[variable.label || variable.name] =
						row[variableToFetchedIndexMap.get(variable.name.toLowerCase())];
				}
				for (const variable of this.filterVariables) {
					properties[variable.name] = row[variableToFetchedIndexMap.get(variable.name.toLowerCase())];
				}
				if (this.regionNameVariable) {
					properties.regionName =
						row[variableToFetchedIndexMap.get(this.regionNameVariable.name.toLowerCase())];
				}
				if (this.regionParentVariable) {
					properties.parentRegionName =
						row[variableToFetchedIndexMap.get(this.regionParentVariable.name.toLowerCase())];
				}
				if (this.regionBoundingBoxVariable) {
					properties.bbox =
						row[variableToFetchedIndexMap.get(this.regionBoundingBoxVariable.name.toLowerCase())];
				}
				return { metadata, properties: { ...metadata, ...properties } };
			});
			return this.metadata;
		} catch (e) {
			await localforage.removeItem(`${CACHE_TOKEN}_version_${apiEndpoint}`);
			await localforage.removeItem(`${CACHE_TOKEN}_response_${apiEndpoint}`);
			alert(`An error occurred when parsing data from ${this.tableIdentifier}: ${e.message}`);
			return [];
		}
	};

	fetchData = async () => {
		if (this.data) {
			return this.data;
		}
		const variablesSet = new Set([...this.geoVariables.map(({ name }) => name.toLowerCase())]);
		if (!this.metadata) {
			await this.fetchMetadata();
		}
		const variablesToFetch = [...variablesSet];
		const variableToFetchedIndexMap = new Map();

		for (let i = 0; i < variablesToFetch.length; i++) {
			variableToFetchedIndexMap.set(variablesToFetch[i], i);
		}

		const apiEndpoint = `https://redivis.com/api/v1/tables/${
			this.tableIdentifier
		}/rows?selectedVariables=${variablesToFetch.join(',')}&maxResults=${MAX_RESULTS}`;

		const data = await this.#fetchFromApi(apiEndpoint);
		try {
			this.data = data.map((row, i) => {
				let geometry;
				if (row[variableToFetchedIndexMap.get(this.geoVariables[0].name.toLowerCase())]) {
					if (this.isGeobuf) {
						geometry = geobuf.decode(
							new Pbf(
								new Uint8Array(
									atob(row[variableToFetchedIndexMap.get(this.geoVariables[0].name.toLowerCase())])
										.split('')
										.map(function (c) {
											return c.charCodeAt(0);
										}),
								),
							),
						).geometry;
					} else {
						geometry = this.getGeometry
							? this.getGeometry(
									...this.geoVariables.map(
										(geoVariable) =>
											row[variableToFetchedIndexMap.get(geoVariable.name.toLowerCase())],
									),
							  )
							: JSON.parse(row[variableToFetchedIndexMap.get(this.geoVariables[0].name.toLowerCase())]);
					}
				}
				return { geometry, ...this.metadata[i] };
			});

			return this.data;
		} catch (e) {
			await localforage.removeItem(`${CACHE_TOKEN}_version_${apiEndpoint}`);
			await localforage.removeItem(`${CACHE_TOKEN}_response_${apiEndpoint}`);
			alert(`An error occurred when parsing data from ${this.tableIdentifier}: ${e.message}`);
			return [];
		}
	};

	#fetchFromApi = async (apiEndpoint, depth = 1) => {
		try {
			let responseText;
			const currentTableVersion = await getTableVersion(this.tableIdentifier);
			try {
				const cachedVersion = await localforage.getItem(`${CACHE_TOKEN}_version_${apiEndpoint}`);
				if (cachedVersion === currentTableVersion) {
					const cachedText = await localforage.getItem(`${CACHE_TOKEN}_response_${apiEndpoint}`);
					responseText = pako.inflate(cachedText, { to: 'string' });
				}
			} catch (e) {
				console.error(e);
				await localforage.removeItem(`${CACHE_TOKEN}_version_${apiEndpoint}`);
				await localforage.removeItem(`${CACHE_TOKEN}_response_${apiEndpoint}`);
			}

			if (!responseText) {
				const response = await retryableFetch(apiEndpoint, {
					method: 'GET',
					headers: {
						Authorization: `Bearer ${ACCESS_TOKEN}`,
					},
				});
				if (!response.ok) {
					const text = await response.text();
					throw new Error(text);
				}

				responseText = await response.text();
				try {
					await localforage.setItem(`${CACHE_TOKEN}_version_${apiEndpoint}`, currentTableVersion);
					await localforage.setItem(`${CACHE_TOKEN}_response_${apiEndpoint}`, pako.deflate(responseText));
				} catch (e) {
					console.error(e);
					await localforage.removeItem(`${CACHE_TOKEN}_version_${apiEndpoint}`);
					await localforage.removeItem(`${CACHE_TOKEN}_response_${apiEndpoint}`);
				}
			}

			let rows = responseText.split('\n').map((row, i) => {
				return JSON.parse(row);
			});
			if (rows.length === 10000) {
				const additionalRows = await this.#fetchFromApi(
					`${apiEndpoint.replace(/&startIndex=\d+/, '')}&startIndex=${depth * 10000}`,
					depth + 1,
				);
				rows = rows.concat(additionalRows);
			}
			return rows;
		} catch (e) {
			await localforage.removeItem(`${CACHE_TOKEN}_version_${apiEndpoint}`);
			await localforage.removeItem(`${CACHE_TOKEN}_response_${apiEndpoint}`);
			alert(`An error occurred when fetching data from ${this.tableIdentifier}: ${e.message}`);
			return [];
		}
	};
}

async function getTableVersion(identifier) {
	const response = await retryableFetch(`https://redivis.com/api/v1/tables/${identifier}`, {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${ACCESS_TOKEN}`,
		},
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(text);
	}
	const table = await response.json();
	return table.hash;
}
