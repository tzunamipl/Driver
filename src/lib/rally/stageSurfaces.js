// Stage surface sections: stretches of a stage road with their own surface, over OSM's paved / unpaved.
// Stage file `surfaces`: [{ surface, from, to, points: [[lat, lon, width], ...] }] - from / to = metres
// along the stage route when it was marked, points = the road's centreline over it, each with the
// width (m) of the stretch after it. Within that width the section wins, junctions included.
// compound = surfaceCompounds.js key (tyres), look = streets.js surface view look.

export const STAGE_SURFACES = {
  tarmac: { label: 'Tarmac', compound: 'road', look: 'paved', color: '#47484c' },
  cobblestone: { label: 'Cobbles', compound: 'cobblestone', look: 'cobblestone', color: '#7d776d' },
  gravel: { label: 'Gravel', compound: 'unpaved', look: 'unpaved', color: '#9c8868' },
  mud: { label: 'Mud', compound: 'mud', look: 'mud', color: '#4f3b26' },
};

export const STAGE_SURFACE_IDS = Object.keys(STAGE_SURFACES);

/** Stage surface id of an OSM road (pacenote calls where no section covers it). */
export const osmStageSurface = (unpaved) => (unpaved ? 'gravel' : 'tarmac');
