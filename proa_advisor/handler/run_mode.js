// Single source of truth for the server run mode.
//   normal: live ADS8688 data into the EKF
//   test:   CSV replay replaces the live ADS8688 data (other sensors stay live)
//   game:   ADS8688 pots/switches drive a coulomb-counting simulation (other sensors stay live)
const RUN_MODES = Object.freeze(['normal', 'test', 'game']);

function getRunMode() {
    const mode = process.env.RUN_MODE;
    return RUN_MODES.includes(mode) ? mode : 'normal';
}

module.exports = {
    RUN_MODES,
    getRunMode
};
