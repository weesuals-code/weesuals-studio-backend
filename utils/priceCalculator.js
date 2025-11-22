// Price configuration
const videoPricing = {
  1: 1500,
  2: 2200,
  3: 3000,
  4: 4000,
  5: 4600,
  6: 5000,
  7: 5400
};

const postPricing = {
  1: 500,
  2: 900,
  3: 1200,
  4: 1400,
  5: 1600,
  6: 1800,
  7: 2000
};

const AD_MANAGEMENT_PRICE = 600;

/**
 * Calculate the price based on the number of videos and posts per week
 * @param {number} videosPerWeek - Number of videos per week (1-7)
 * @param {number} postsPerWeek - Number of posts per week (1-7)
 * @param {boolean} includeAdManagement - Whether to include ad management
 * @returns {Object} - Object containing calculated prices
 */
function calculatePrice(videosPerWeek, postsPerWeek, includeAdManagement) {
  const videoCost = videoPricing[videosPerWeek] || 0;
  const postCost = postPricing[postsPerWeek] || 0;
  const basePrice = videoCost + postCost;
  
  // Ad management is free if base price is 4000 RON or more
  const adCost = includeAdManagement ? (basePrice >= 4000 ? 0 : AD_MANAGEMENT_PRICE) : 0;
  const totalPrice = basePrice + adCost;
console.log(totalPrice)
  return {
    videoCost,
    postCost,
    basePrice,
    adCost,
    totalPrice
  };
}

module.exports = {
  calculatePrice
};
