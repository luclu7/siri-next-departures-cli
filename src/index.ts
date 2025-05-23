import { checkbox, search } from '@inquirer/prompts';
import axios from 'axios';
import { Command } from 'commander';
import { remove as removeDiacritics } from 'diacritics';
import * as dotenv from 'dotenv';
import { XMLParser } from 'fast-xml-parser';
import * as fs from 'fs';
import * as path from 'path';
import { Stop } from './types/siri';

// Chargement des variables d'environnement
dotenv.config();

if (!process.env.SIRI_ENDPOINT || !process.env.NETEX_FILE || !process.env.DATASET_ID) {
  throw new Error('Les variables d\'environnement SIRI_ENDPOINT, NETEX_FILE et DATASET_ID sont requises.');
}

const SIRI_ENDPOINT = process.env.SIRI_ENDPOINT;
const NETEX_FILE = path.join(process.cwd(), process.env.NETEX_FILE);
const datasetId = process.env.DATASET_ID;

const program = new Command();

program
  .name('siri-next-departures-cli')
  .description('CLI pour obtenir les prochains départs via une API SIRI')
  .version('1.0.0')
  .option('-s, --stops <stopIds...>', 'IDs des arrêts')
  .option('-l, --limit <number>', 'Nombre maximum de passages à afficher par arrêt', '5')
  .option('-f, --find', 'Rechercher des arrêts');

program.parse(process.argv);

const options = program.opts();

function normalizeString(str: string): string {
  return removeDiacritics(str)
    .toLowerCase()
    .replace(/[\s-]+/g, '');
}

async function loadStops(): Promise<Stop[]> {
  console.log('Chargement des arrêts...');
  const xmlData = fs.readFileSync(NETEX_FILE, 'utf-8');
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    isArray: (name) => name === 'KeyValue'
  });
  
  const result = parser.parse(xmlData);
  const stops: Stop[] = [];

  const members = result.PublicationDelivery.dataObjects.GeneralFrame.members;
  
  if (members && members.Quay) {
    const quays = Array.isArray(members.Quay) ? members.Quay : [members.Quay];
    const stopPlaces = Array.isArray(members.StopPlace) ? members.StopPlace : [members.StopPlace];
    console.log(`Nombre d'arrêts trouvés : ${quays.length}`);
   
    for (const quay of quays) {
      const id = quay['@_id'] || '';
      const name = quay.Name;
      const transportMode = quay.TransportMode;
      const siteRef = quay.SiteRef?.['@_ref'];
  
      // Trouver le StopPlace parent en utilisant le SiteRef
      const stopPlace = stopPlaces.find((sp: any) => sp['@_id'] === siteRef);
      const otherTransportModes = stopPlace?.OtherTransportModes ? 
        stopPlace.OtherTransportModes.split(' ') : [];

      const stop: Stop = {
        id,
        name,
        transportMode,
        otherTransportModes,
        normalizedName: normalizeString(name),
        normalizedId: normalizeString(id),
        parentStopPlaceId: stopPlace?.['@_id']
      };

      stops.push(stop);
    }
  }

  console.log(`Arrêts chargés : ${stops.length}`);
  return stops;
}

function filterStops(stops: Stop[], searchTerm: string): Stop[] {
  const normalizedSearch = normalizeString(searchTerm);
  
  return stops.filter(stop => {
    return stop.normalizedName?.includes(normalizedSearch) ||
           stop.normalizedId?.includes(normalizedSearch);
  });
}

async function findStops(): Promise<string[]> {
  const stops = await loadStops();
  
  // Regrouper les arrêts par StopPlace
  const stopPlaces = new Map<string, { name: string, quays: Stop[] }>();
  stops.forEach(stop => {
    if (stop.parentStopPlaceId) {
      if (!stopPlaces.has(stop.parentStopPlaceId)) {
        stopPlaces.set(stop.parentStopPlaceId, {
          name: stop.name.split(' - ')[0], // Prendre le nom du StopPlace (sans le nom du quai)
          quays: []
        });
      }
      stopPlaces.get(stop.parentStopPlaceId)?.quays.push(stop);
    }
  });

  // Recherche du StopPlace
  const searchStopPlaces = async (input = '') => {
    const normalizedSearch = normalizeString(input);
    return Array.from(stopPlaces.entries())
      .filter(([_, place]) => normalizeString(place.name).includes(normalizedSearch))
      .map(([id, place]) => ({
        name: `${place.name} (${place.quays.length} quai${place.quays.length > 1 ? 's' : ''})`,
        value: id,
        description: `ID: ${id}`
      }));
  };

  const selectedStopPlaceId = await search({
    message: 'Rechercher un arrêt principal :',
    source: searchStopPlaces,
    pageSize: 10
  });

  if (!selectedStopPlaceId) {
    return [];
  }

  const selectedStopPlace = stopPlaces.get(selectedStopPlaceId);
  if (!selectedStopPlace) {
    return [];
  }

  // Sélection des Quays
  const quayChoices = selectedStopPlace.quays.map(quay => ({
    name: `${quay.name} [${quay.id}] — ${quay.transportMode}${quay.otherTransportModes.length > 0 ? ` — Correspondances : ${quay.otherTransportModes.join(', ')}` : ''}`,
    value: quay.id,
    description: `ID: ${quay.id}`
  }));

  const selectedQuays = await checkbox({
    message: `Sélectionnez les quais de ${selectedStopPlace.name} (utilisez la barre d'espace pour sélectionner, Entrée pour valider) :`,
    choices: quayChoices,
    pageSize: 10
  });

  return selectedQuays;
}

function generateSiriXml(stopIds: string[], limit: number): string {
  const stopMonitoringRequests = stopIds.map(stopId => `
    <StopMonitoringRequest version="2.0">
      <MonitoringRef>${stopId}</MonitoringRef>
      <MaximumStopVisits>${limit}</MaximumStopVisits>
    </StopMonitoringRequest>
  `).join('');

  return `<?xml version="1.0" encoding="utf-8"?>
  <Siri xmlns="http://www.siri.org.uk/siri" xmlns:ns2="http://www.ifopt.org.uk/acsb" xmlns:ns3="http://www.ifopt.org.uk/ifopt" xmlns:ns4="http://da-tex2.eu/schema/2_0RC1/2_0" version="2.0">
      <ServiceRequest>
          <RequestorRef>opendata</RequestorRef>
          ${stopMonitoringRequests}
      </ServiceRequest>
  </Siri>`
}

async function getNextTrams(stopIds: string[], limit: number) {
  try {
    const xmlRequest = generateSiriXml(stopIds, limit);
    console.log('Envoi de la requête XML :', xmlRequest);
    
    const response = await axios.post(
      SIRI_ENDPOINT,
      xmlRequest,
      {
        headers: {
          'Content-Type': 'application/xml',
          datasetId
        },
      }
    );

    console.log("Status code :", response.status);
    console.log(response.data);

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true,
      isArray: (name) => name === 'KeyValue' || name === 'MonitoredStopVisit'
    });

    const result = parser.parse(response.data);

    if (!result || !result.Siri || !result.Siri.ServiceDelivery) {
      console.error('Format de réponse invalide');
      return;
    }

    const serviceDelivery = result.Siri.ServiceDelivery;
    const stopMonitoringDeliveries = Array.isArray(serviceDelivery.StopMonitoringDelivery) 
      ? serviceDelivery.StopMonitoringDelivery 
      : [serviceDelivery.StopMonitoringDelivery];

    for (const delivery of stopMonitoringDeliveries) {
      const stopId = delivery.MonitoringRef;
      const visits = delivery.MonitoredStopVisit;

      console.log(`\nArrêt ${stopId} :`);
      
      if (!visits || visits.length === 0) {
        console.log('Aucun passage prévu pour cet arrêt.');
        continue;
      }

      console.log('Prochains passages :\n');
      visits.forEach((visit: any) => {
        const journey = visit.MonitoredVehicleJourney;
        const lineRef = journey.LineRef;
        const destination = journey.DestinationName["#text"];
        const expectedTime = new Date(journey.MonitoredCall.ExpectedDepartureTime);
        const aimedTime = new Date(journey.MonitoredCall.AimedDepartureTime);
        const quay = journey.MonitoredCall.StopPointRef;
        
        console.log(`Ligne ${lineRef} vers ${destination}`);
        console.log(`Départ prévu : ${expectedTime.toLocaleTimeString()}`);
        console.log(`Départ théo. : ${aimedTime.toLocaleTimeString()}`);
        console.log(`Quai : ${quay}`);
        console.log('---');
      });
    }
  } catch (error) {
    if (axios.isAxiosError(error)) {
      console.error('Erreur lors de la récupération des données :', error.response?.data || error.message);
    } else {
      console.error('Erreur inattendue :', error);
    }
  }
}

async function main() {
  try {
    let stopIds = options.stops || [];
    const limit = parseInt(options.limit || '5');

    if (options.find || stopIds.length === 0) {
      const selectedStops = await findStops();
      if (selectedStops.length === 0) {
        return;
      }
      stopIds = selectedStops;
    }

    await getNextTrams(stopIds, limit);
  } catch (error) {
    console.error('Erreur :', error);
  }
}

main();