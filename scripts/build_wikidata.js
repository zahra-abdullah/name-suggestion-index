const colors = require('colors/safe');
const fetch = require('node-fetch');
const fileTree = require('../lib/file_tree.js');
const fs = require('fs');
const iso1A2Code = require('@ideditor/country-coder').iso1A2Code;
const prettyStringify = require('json-stringify-pretty-compact');
const sort = require('../lib/sort.js');

// We use LocationConflation for validating and processing the locationSets
const featureCollection = require('../dist/featureCollection.json');
const LocationConflation = require('@ideditor/location-conflation');
const loco = new LocationConflation(featureCollection);

const wbk = require('wikibase-sdk')({
  instance: 'https://www.wikidata.org',
  sparqlEndpoint: 'https://query.wikidata.org/sparql'
});


// First, try to load the user's secrets.
// This is optional but needed if you want this script to:
// - connect to the Twitter API to fetch logos
// - connect to the Wikibase API to update NSI identifiers.
//
// `config/secrets.json` looks like this:
// {
//   "twitter": [
//     {
//       "twitter_consumer_key": "",
//       "twitter_consumer_secret": "",
//       "twitter_access_token_key": "",
//       "twitter_access_token_secret": ""
//     }, {
//       "twitter_consumer_key": "",
//       "twitter_consumer_secret": "",
//       "twitter_access_token_key": "",
//       "twitter_access_token_secret": ""
//     }
//   ],
//   "wikibase": {
//       dunno yet
//   }
// }

let _secrets;
try {
  _secrets = require('../config/secrets.json');
} catch (err) { /* ignore */ }

if (_secrets && !_secrets.twitter && !_secrets.wikibase) {
  console.error(colors.red('WHOA!'));
  console.error(colors.yellow('The `config/secrets.json` file format has changed a bit.'));
  console.error(colors.yellow('We were expecting to find `twitter` or `wikibase` properties.'));
  console.error(colors.yellow('Check `scripts/build_wikidata.js` for details...'));
  console.error('');
  process.exit(1);
}

// To fetch Twitter logos, sign up for API credentials at https://apps.twitter.com/
// and put them into `config/secrets.json`
let Twitter;
let _twitterAPIs = [];
let _twitterAPIIndex = 0;
if (_secrets && _secrets.twitter) {
  try {
    Twitter = require('twitter');
  } catch (err) {
    console.error(colors.yellow(`Looks like you don't have the optional Twitter package installed`));
    console.error(colors.yellow('Try `npm install twitter` to install it.'));
  }
  if (Twitter) {
    _twitterAPIs = _secrets.twitter.map(s => {
      return new Twitter({
        consumer_key: s.twitter_consumer_key,
        consumer_secret: s.twitter_consumer_secret,
        access_token_key: s.twitter_access_token_key,
        access_token_secret: s.twitter_access_token_secret
      });
    });
  }
}

// To update wikibase, .. ?
// and put them into `config/secrets.json`
if (_secrets && _secrets.wikibase) {
  // ?
}



// what to fetch
let _cache = { path: {}, id: {} };
fileTree.read('brands', _cache, loco);


// gather QIDs..
let _wikidata = {};
let _qidNames = {};       // we use this just for displaying information in the console
Object.values(_cache.id).forEach(item => {
  const tags = item.tags;
  ['brand', 'operator', 'network'].forEach(osmtag => {
    const wdtag = `${osmtag}:wikidata`;
    const entag = `${osmtag}:en`;
    const qid = tags[wdtag];
    if (qid && /^Q\d+$/.test(qid) && !_wikidata[qid]) {   // valid QID not already gathered
      _wikidata[qid] = {};
      _qidNames[qid] = tags['name:en'] || tags.name || tags[entag] || tags[osmtag];
    }
  });
});

let _qids = Object.keys(_wikidata);
let _total = _qids.length;
if (!_total) {
  console.log('Nothing to fetch');
  process.exit();
}

// Chunk into multiple wikidata API requests..
let _urls = wbk.getManyEntities({
  ids: _qids,
  languages: ['en'],
  props: ['info', 'labels', 'descriptions', 'claims'],
  format: 'json'
});

let _errors = [];
doFetch().then(finish);



//
// `doFetch`
// Returns a Promise that keeps fetching Wikidata API requests recursively
// until there is nothing left to fetch, then returns a resolved Promise
//
function doFetch(index) {
  index = index || 0;
  if (index >= _urls.length) {
    return Promise.resolve();
  }

  let currURL = _urls[index];

  console.log(colors.yellow.bold(`\nBatch ${index+1}/${_urls.length}`));

  return fetch(currURL)
    .then(response => {
      if (!response.ok) throw new Error(response.status + ' ' + response.statusText);
      return response.json();
    })
    .then(result => processEntities(result))
    .catch(e => {
      _errors.push(e);
      console.error(colors.red(e));
    })
    .then(() => delay(500))
    .then(() => doFetch(++index));
}


//
// `processEntities`
// Here we process the fetched results from the Wikidata API,
// then schedule followup API calls to the Twitter/Facebook APIs,
// then eventually resolves when all that work is done.
//
function processEntities(result) {
  let twitterQueue = [];
  let facebookQueue = [];

  Object.keys(result.entities).forEach(qid => {
    let target = _wikidata[qid];
    let entity = result.entities[qid];
    let label = entity.labels && entity.labels.en && entity.labels.en.value;
    let description = entity.descriptions && entity.descriptions.en && entity.descriptions.en.value;

    if (Object.prototype.hasOwnProperty.call(entity, 'missing')) {
      const msg = colors.yellow(`Error: https://www.wikidata.org/wiki/${qid}`) +
        colors.red(`  Entity for "${_qidNames[qid]}" was deleted.`);
      _errors.push(msg);
      console.error(msg);
      return;
    }

    if (label) {
      target.label = label;
    } else {
      const msg = colors.yellow(`Error: https://www.wikidata.org/wiki/${qid}`) +
        colors.red(`  Entity for "${_qidNames[qid]}" missing English label.`);
      _errors.push(msg);
      console.error(msg);
    }

    if (description) {
      target.description = description;
    }

    // process claims below here
    if (!entity.claims) return;
    target.logos = {};
    target.identities = {};
    target.dissolutions = [];

    // P154 - Commons Logo (often not square)
    const wikidataLogo = getClaimValue(entity, 'P154');
    if (wikidataLogo) {
      target.logos.wikidata = 'https://commons.wikimedia.org/w/index.php?' +
        utilQsString({ title: `Special:Redirect/file/${wikidataLogo}`, width: 100 });
    }

    // P856 - official website
    const officialWebsite = getClaimValue(entity, 'P856');
    if (officialWebsite) {
      target.identities.website = officialWebsite;
    }

    // P2002 - Twitter username
    const twitterUser = getClaimValue(entity, 'P2002');
    if (twitterUser) {
      target.identities.twitter = twitterUser;
      twitterQueue.push({ qid: qid, username: twitterUser });    // queue logo fetch
    }

    // P2003 - Instagram ID
    const instagramUser = getClaimValue(entity, 'P2003');
    if (instagramUser) {
      target.identities.instagram = instagramUser;
    }

    // P2013 - Facebook ID
    const facebookUser = getClaimValue(entity, 'P2013');
    if (facebookUser) {
      target.identities.facebook = facebookUser;
      facebookQueue.push({ qid: qid, username: facebookUser });    // queue logo fetch
    }

    // P2397 - YouTube ID
    const youtubeUser = getClaimValue(entity, 'P2397');
    if (youtubeUser) {
      target.identities.youtube = youtubeUser;
    }

    // P2984 - Snapchat ID
    const snapchatUser = getClaimValue(entity, 'P2984');
    if (snapchatUser) {
      target.identities.snapchat = snapchatUser;
    }

    // P3185 - VK ID
    const vkUser = getClaimValue(entity, 'P3185');
    if (vkUser) {
      target.identities.vk = vkUser;
    }

    // P3836 - Pinterest ID
    const pinterestUser = getClaimValue(entity, 'P3836');
    if (pinterestUser) {
      target.identities.pinterest = pinterestUser;
    }

    // P4264 - LinkedIn Company ID
    const linkedinUser = getClaimValue(entity, 'P4264');
    if (linkedinUser) {
      target.identities.linkedin = linkedinUser;
    }

    // P576 - Dissolution date
    wbk.simplify.propertyClaims(entity.claims.P576, { keepQualifiers: true }).forEach(item => {
      let dissolution = { date: item.value };

      if (item.qualifiers) {
        // P17 - Countries where the brand is dissoluted
        const countries = item.qualifiers.P17;
        if (countries) {
          dissolution.countries = countries.map(iso1A2Code);
        }
        // P156 - followed by or P1366 - replaced by (successor)
        const successorQID = item.qualifiers.P156 || item.qualifiers.P1366;
        if (successorQID) {
          dissolution.upgrade = successorQID;
        }
      }

      if (!dissolution.upgrade) {
        // Sometimes the successor is stored as a claim and not as a direct reference of the dissolution date claim
        // Only set the value if there is nothing set yet, as the reference value of the claim might be more detailed
        // P156 - followed by or P1366 - replaced by (successor)
        let successor = getClaimValue(entity, 'P156') || getClaimValue(entity, 'P1366');
        if (successor && successor.id) {
          dissolution.upgrade = successor.id;
        }
      }

      if (dissolution.upgrade) {
        let msg = colors.yellow(`Error: https://www.wikidata.org/wiki/${qid}`) +
          colors.red(`  ${target.label} might possibly be replaced by ${dissolution.upgrade}`);
        if (dissolution.countries) {
          msg += colors.red(`\nThis applies only to the following countries: ${JSON.stringify(dissolution.countries)}.`);
        }
        _errors.push(msg);
        console.error(msg);
      }
      target.dissolutions.push(dissolution);
    });

  });

  if (_twitterAPIs.length && twitterQueue.length) {
    return checkTwitterRateLimit(twitterQueue.length)
      .then(() => Promise.all(twitterQueue.map(obj => fetchTwitterUserDetails(obj.qid, obj.username)) ))
      .then(() => Promise.all(facebookQueue.map(obj => fetchFacebookLogo(obj.qid, obj.username)) ));
  } else {
    return Promise.all(facebookQueue.map(obj => fetchFacebookLogo(obj.qid, obj.username)));
  }
}


// `getClaimValue`
// Get the claim value, considering any claim rank..
//   - disregard any claimes with an end date qualifier in the past
//   - disregard any claims with "deprecated" rank
//   - accept immediately any claim with "preferred" rank
//   - return the latest claim with "normal" rank
function getClaimValue(entity, prop) {
  if (!entity.claims) return;
  if (!entity.claims[prop]) return;

  let value;
  for (let i = 0; i < entity.claims[prop].length; i++) {
    const c = entity.claims[prop][i];
    if (c.rank === 'deprecated') continue;
    if (c.mainsnak.snaktype !== 'value') continue;

    // skip if we find an end time qualifier - P582
    let ended = false;
    const qualifiers = (c.qualifiers && c.qualifiers.P582) || [];
    for (let j = 0; j < qualifiers.length; j++) {
      const q = qualifiers[j];
      if (q.snaktype !== 'value') continue;
      const enddate = wbk.wikibaseTimeToDateObject(q.datavalue.value.time);
      if (new Date() > enddate) {
        ended = true;
        break;
      }
    }
    if (ended) continue;

    value = c.mainsnak.datavalue.value;
    if (c.rank === 'preferred') return value;  // return immediately
  }
  return value;
}


// `finish`
// Wrap up, write files
// - wikidata.json
// - dissolved.json
//
function finish() {
  const START = '🏗   ' + colors.yellow('Writing output files');
  const END = '👍  ' + colors.green('output files updated');
  console.log('');
  console.log(START);
  console.time(END);

  // update wikidata.json
  let origWikidata;
  try {
    origWikidata = require('../dist/wikidata.json').wikidata;
  } catch (err) {
    origWikidata = {};
  }

  Object.keys(_wikidata).forEach(qid => {
    let target = _wikidata[qid];

    // if we haven't been able to access the Twitter API, don't overwrite the Twitter data - #3569
    if (!_twitterAPIs.length) {
      const origTarget = origWikidata[qid];
      ['identities', 'logos'].forEach(prop => {
        const origTwitter = origTarget && origTarget[prop] && origTarget[prop].twitter;
        if (origTwitter) {
          target[prop] = target[prop] || {};
          target[prop].twitter = origTwitter;
        }
      });
    }

    // sort the properties that we are keeping..
    ['identities', 'logos', 'dissolutions'].forEach(prop => {
      if (target[prop] && Object.keys(target[prop]).length) {
        if (target[prop].constructor.name === 'Object') {
          target[prop] = sort(target[prop]);
        }
      } else {
        delete target[prop];
      }
    });

    _wikidata[qid] = sort(target);
  });

  fs.writeFileSync('dist/wikidata.json', prettyStringify({ wikidata: sort(_wikidata) }));


  // update dissolved.json
  let dissolved = {};
  Object.values(_cache.id).forEach(item => {
    const tags = item.tags;
    let qid = tags['brand:wikidata'];
    if (qid && _wikidata[qid].dissolutions && _wikidata[qid].dissolutions.length > 0) {
      dissolved[item.id] = _wikidata[qid].dissolutions;
    }
  });
  fs.writeFileSync('dist/dissolved.json', prettyStringify(sort(dissolved), { maxLength: 100 }));

  console.timeEnd(END);

  // output whatever errors we've gathered
  if (_errors.length) {
    console.log(colors.yellow.bold(`\nError Summary:`));
    _errors.forEach(msg => console.error(colors.red(msg)));
  }
}


// check Twitter rate limit status
// https://developer.twitter.com/en/docs/developer-utilities/rate-limit-status/api-reference/get-application-rate_limit_status
// rate limit: 900calls / 15min
function checkTwitterRateLimit(need) {
  _twitterAPIIndex = (_twitterAPIIndex + 1) % _twitterAPIs.length;
  const twitterAPI = _twitterAPIs[_twitterAPIIndex];
  const which = _twitterAPIs.length > 1 ? (' ' + (_twitterAPIIndex + 1)) : '';

  return twitterAPI
    .get('application/rate_limit_status', { resources: 'users' })
    .then(result => {
      const now = Date.now() / 1000;
      const stats = result.resources.users['/users/show/:id'];
      const resetSec = Math.ceil(stats.reset - now) + 30;  // +30sec in case server time is different
      console.log(colors.green.bold(`Twitter rate status${which}: need ${need}, remaining ${stats.remaining}, resets in ${resetSec} seconds...`));
      if (need > stats.remaining) {
        const delaySec = clamp(resetSec, 10, 60);
        console.log(colors.blue(`Twitter rate limit exceeded, pausing for ${delaySec} seconds...`));
        return delaySec;
      } else {
        return 0;
      }
    })
    .then(sec => {
      if (sec > 0) {
        return delay(sec * 1000)
          .then(() => checkTwitterRateLimit(need));
      } else {
        return Promise.resolve();
      }
    })
    .catch(e => {
      console.error(colors.blue(`Error: Twitter rate limit: ` + JSON.stringify(e)));
    });
}


// https://developer.twitter.com/en/docs/accounts-and-users/user-profile-images-and-banners.html
// https://developer.twitter.com/en/docs/accounts-and-users/follow-search-get-users/api-reference/get-users-show
function fetchTwitterUserDetails(qid, username) {
  const target = _wikidata[qid];
  const twitterAPI = _twitterAPIs[_twitterAPIIndex];

  return twitterAPI
    .get('users/show', { screen_name: username })
    .then(user => {
      target.logos.twitter = user.profile_image_url_https.replace('_normal', '_bigger');
    })
    .catch(e => {
      const msg = colors.yellow(`Error: https://www.wikidata.org/wiki/${qid}`) +
        colors.red(`  Twitter username @${username}: ${JSON.stringify(e)}`);
      _errors.push(msg);
      console.error(colors.red(msg));
    });
}


// https://developers.facebook.com/docs/graph-api/reference/user/picture/
function fetchFacebookLogo(qid, username) {
  let target = _wikidata[qid];
  let logoURL = `https://graph.facebook.com/${username}/picture?type=large`;

  return fetch(logoURL)
    .then(response => {
      if (!response.ok) {
        return response.json();  // we should get a response body with more information
      }
      if (response.headers.get('content-md5') !== 'OMs/UjwLoIRaoKN19eGYeQ==') {  // question-mark image #2750
        target.logos.facebook = logoURL;
      }
      return {};
    })
    .then(json => {
      if (json && json.error && json.error.message) {
        throw new Error(json.error.message);
      }
      return true;
    })
    .catch(e => {
      const msg = colors.yellow(`Error: https://www.wikidata.org/wiki/${qid}`) +
        colors.red(`  Facebook username @${username}: ${e}`);
      _errors.push(msg);
      console.error(colors.red(msg));
    });
}


function delay(msec) {
  return new Promise(resolve => setTimeout(resolve, msec));
}


// Clamp a number between min and max
function clamp(num, min, max) {
  return Math.min(Math.max(num, min), max);
}


function utilQsString(obj) {
  return Object.keys(obj).sort().map(function(key) {
    return encodeURIComponent(key) + '=' + encodeURIComponent(obj[key]);
  }).join('&');
}
