import { Command } from 'commander';
import axios from 'axios';
import { XMLParser } from 'fast-xml-parser';
import { search } from '@inquirer/prompts';
import * as fs from 'fs';
import * as path from 'path';
import { remove as removeDiacritics } from 'diacritics';
import * as dotenv from 'dotenv';
import { Stop, SiriXmlResponse } from './types/siri';

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
  .option('-s, --stop <stopId>', 'ID de l\'arrêt')
  .option('-l, --limit <number>', 'Nombre maximum de passages à afficher', '5')
  .option('-f, --find', 'Rechercher un arrêt');

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

async function findStop(): Promise<string | undefined> {
  const stops = await loadStops();
  
  const searchStops = async (input = '') => {
    const results = filterStops(stops, input);
    return results.map(stop => {
      const correspondances = stop.otherTransportModes.length > 0 
        ? ` — Correspondances : ${stop.otherTransportModes.join(', ')}`
        : '';
      return {
        name: `${stop.name} — ${stop.transportMode}${correspondances} (${stop.id} ${stop.parentStopPlaceId})`,
        value: stop.id,
        description: stop.name
      };
    });
  };

  const selectedStop = await search({
    message: 'Rechercher un arrêt :',
    source: searchStops,
    pageSize: 10
  });

  return selectedStop;
}

function generateSiriXml(stopId: string, limit: number): string {
  return `<?xml version="1.0" encoding="utf-8"?>
  <Siri xmlns="http://www.siri.org.uk/siri" xmlns:ns2="http://www.ifopt.org.uk/acsb" xmlns:ns3="http://www.ifopt.org.uk/ifopt" xmlns:ns4="http://da-tex2.eu/schema/2_0RC1/2_0" version="2.0">
      <ServiceRequest>
          <RequestorRef>opendata</RequestorRef>
          <StopMonitoringRequest version="2.0">
              <MonitoringRef>${stopId}</MonitoringRef>
          </StopMonitoringRequest>
      </ServiceRequest>
  </Siri>`
}

async function getNextTrams(stopId: string, limit: number) {
  try {
    const xmlRequest = generateSiriXml(stopId, limit);
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
    // print prettied XML
    console.log(response.data);

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      removeNSPrefix: true
    });

    const result = parser.parse(response.data);

    if (!result || !result.Siri || !result.Siri.ServiceDelivery) {
      console.error('Format de réponse invalide');
      return;
    }

    const serviceDelivery = result.Siri.ServiceDelivery;
    const stopMonitoring = serviceDelivery.StopMonitoringDelivery;
    const visits = stopMonitoring?.MonitoredStopVisit;

    if (!visits || visits.length === 0) {
      console.log('Aucun passage prévu pour cet arrêt.');
      return;
    }

    console.log('\nProchains passages :\n');
    visits.forEach((visit: any) => {
      const journey = visit.MonitoredVehicleJourney;
      const lineRef = journey.LineRef;
      const destination = journey.DestinationName["#text"];
      const expectedTime = new Date(journey.MonitoredCall.ExpectedDepartureTime);
      const aimedTime = new Date(journey.MonitoredCall.AimedDepartureTime);
      
      console.log(`Ligne ${lineRef} vers ${destination}`);
      console.log(`Départ prévu : ${expectedTime.toLocaleTimeString()}`);
      console.log(`Départ théorique : ${aimedTime.toLocaleTimeString()}`);
      console.log('---');
    });
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
    let stopId = options.stop;
    const limit = parseInt(options.limit || '5');

    if (options.find || !stopId) {
      stopId = await findStop();
      if (!stopId) {
        return;
      }
    }

    await getNextTrams(stopId, limit);
  } catch (error) {
    console.error('Erreur :', error);
  }
}

main();