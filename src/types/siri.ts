export interface Stop {
  id: string;
  name: string;
  normalizedName?: string;
  normalizedId?: string;
  transportMode: "bus" | "tram" | "ferry";
  parentStopPlaceId?: string;
  otherTransportModes: string[];
}

export interface MonitoredVehicleJourney {
  LineRef: [string];
  DestinationName: [string];
  MonitoredCall: [{
    ExpectedDepartureTime: [string];
    AimedDepartureTime: [string];
  }];
}

export interface MonitoredStopVisit {
  MonitoredVehicleJourney: [MonitoredVehicleJourney];
}

export interface SiriXmlResponse {
  Siri: {
    ServiceDelivery: [{
      ResponseTimestamp: [string];
      StopMonitoringDelivery: [{
        ResponseTimestamp: [string];
        MonitoredStopVisit?: MonitoredStopVisit[];
      }];
    }];
  };
} 